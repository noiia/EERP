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
	if len(cols) == 0 {
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
		out = append(out, publishedTable{Table: table, Declared: declared, Fields: sel.Fields, Filter: sel.Filter})
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
