// Package website holds the public-site plumbing of ADR-024: which data
// anonymous visitors may read, which tenant the site serves, and website
// (visitor) accounts.
package website

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// PublicKey is the app_settings key holding table's published selection.
func PublicKey(table string) string { return "website.public." + table }

// Selection is what an admin publishes for one table. Filter values are
// strings: they're compared as text, like ?filter[col]= (so "true" for a bool).
type Selection struct {
	Fields []string          `json:"fields"`
	Filter map[string]string `json:"filter,omitempty"`
}

// SettingsStore is satisfied by *settings.Repository.
type SettingsStore interface {
	Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error)
	Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error
}

type Publisher struct {
	store      SettingsStore
	siteTenant uuid.UUID
}

func NewPublisher(store SettingsStore, siteTenant uuid.UUID) *Publisher {
	return &Publisher{store: store, siteTenant: siteTenant}
}

// Resolve computes the effective scope for table in the site tenant:
// declared ∩ published fields, plus "id". Matches server.PublicResolver.
// ponytail: one indexed app_settings read per public request; cache in-process if it shows up in profiles.
func (p *Publisher) Resolve(ctx context.Context, table string) (access.PublicScope, bool, error) {
	declared, ok := orm.PublicFields(table)
	if !ok {
		return access.PublicScope{}, false, nil
	}
	sel, ok, err := p.load(ctx, p.siteTenant, table)
	if err != nil || !ok {
		return access.PublicScope{}, false, err
	}
	var cols []string
	for _, f := range sel.Fields {
		if slices.Contains(declared, f) && f != "id" {
			cols = append(cols, f)
		}
	}
	// Non-column anchor fields (e.g. "picture") alone would publish the table
	// as bare ids — require at least one real column.
	if !slices.ContainsFunc(cols, func(f string) bool { return orm.TableHasColumn(table, f) }) {
		return access.PublicScope{}, false, nil
	}
	return access.PublicScope{Columns: append(cols, "id"), Equals: sel.Filter}, true, nil
}

func (p *Publisher) load(ctx context.Context, tenant uuid.UUID, table string) (Selection, bool, error) {
	raw, found, err := p.store.Get(ctx, tenant, uuid.Nil, PublicKey(table))
	if err != nil {
		return Selection{}, false, fmt.Errorf("website: load selection %s: %w", table, err)
	}
	var sel Selection
	if !found || raw == "" || json.Unmarshal([]byte(raw), &sel) != nil {
		return Selection{}, false, nil // unparsable degrades to unpublished, like every settings read
	}
	return sel, true, nil
}

var errSelection = errors.New("invalid selection")

func validateSelection(table string, declared []string, sel Selection) error {
	for _, f := range sel.Fields {
		if !slices.Contains(declared, f) {
			return fmt.Errorf("%w: %s is not declared public by its module", errSelection, f)
		}
	}
	if len(sel.Fields) > 0 && !slices.ContainsFunc(sel.Fields, func(f string) bool { return f != "id" && orm.TableHasColumn(table, f) }) {
		return fmt.Errorf("%w: select at least one data column, not only attachments/pictures", errSelection)
	}
	for col := range sel.Filter {
		if !orm.TableHasColumn(table, col) {
			return fmt.Errorf("%w: unknown filter column %s", errSelection, col)
		}
	}
	return nil
}

type publishedTable struct {
	Table    string            `json:"table"`
	Declared []string          `json:"declared"`
	Fields   []string          `json:"fields"`
	Filter   map[string]string `json:"filter"`
	// Pictures are the declared fields that can hold a picture: an anchor
	// field that isn't a column, or a boolean column (the picture widgets'
	// "true ⇔ a picture exists" flag). The editor's picture pickers offer only these.
	Pictures []string `json:"pictures"`
}

func pictureFields(table string, declared []string) []string {
	out := []string{}
	for _, f := range declared {
		if t, isCol := orm.ColumnGoType(table, f); !isCol || t == "bool" || t == "*bool" {
			out = append(out, f)
		}
	}
	return out
}

// GetPublished handles GET /api/v1/settings/website/public (settings:website:read).
func (p *Publisher) GetPublished(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	out := []publishedTable{}
	for table, declared := range orm.PublicTables() {
		sel, _, err := p.load(ctx, tenant, table)
		if err != nil {
			return err
		}
		if sel.Fields == nil { // unpublished: [] not null, the client's contract is string[]
			sel.Fields = []string{}
		}
		out = append(out, publishedTable{Table: table, Declared: declared, Fields: sel.Fields, Filter: sel.Filter, Pictures: pictureFields(table, declared)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Table < out[j].Table })
	return c.JSON(http.StatusOK, out)
}

// PutPublished handles PUT /api/v1/settings/website/public/:table (settings:website:write).
func (p *Publisher) PutPublished(c *echo.Context) error {
	ctx := c.Request().Context()
	table := c.Param("table")
	declared, ok := orm.PublicFields(table)
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "table declares no public fields")
	}
	var sel Selection
	if err := c.Bind(&sel); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := validateSelection(table, declared, sel); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	raw, err := json.Marshal(sel)
	if err != nil {
		return err
	}
	if err := p.store.Set(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, PublicKey(table), string(raw)); err != nil {
		return fmt.Errorf("website: save selection: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}

// ActiveOnly hides tables of deactivated modules from the public surface.
// Plain func types keep this package free of an orm/server import.
func ActiveOnly(
	isActive func(table string) bool,
	resolve func(context.Context, string) (access.PublicScope, bool, error),
) func(context.Context, string) (access.PublicScope, bool, error) {
	return func(ctx context.Context, table string) (access.PublicScope, bool, error) {
		if !isActive(table) {
			return access.PublicScope{}, false, nil
		}
		return resolve(ctx, table)
	}
}
