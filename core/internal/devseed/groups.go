package devseed

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"core/orm"

	"github.com/google/uuid"
)

// The full volume is seeded by groups (one business area each), so a
// workspace can seed some now and the rest later. A group is the run of
// `steps` from its Start entity up to the next group's start; Deps are the
// groups whose rows it points at (selecting it selects them), Uses the ones
// whose seeded rows it may link to without requiring them (invoices → their
// accepted quote). Each group is seeded at most once per tenant (a marker
// per group). When a group is skipped — already seeded, or not selected —
// but a group seeded now depends on or uses it, only its prepare steps run:
// the temp tables (seed_contacts, seed_variants…) the later steps join.

// Group describes one seedable business area.
type Group struct {
	Key   string   `json:"key"`
	Label string   `json:"label"`
	Deps  []string `json:"deps"`
	Uses  []string `json:"-"`
	Start string   `json:"-"` // entity of the group's first step
}

// AllGroups, in seeding order (a group only depends on earlier ones).
var AllGroups = []Group{
	{Key: "base", Label: "Companies & tax catalog", Start: "company"},
	{Key: "products", Label: "Products & variants", Start: "product"},
	{Key: "contacts", Label: "Contacts", Start: "contact"},
	{Key: "crm", Label: "CRM leads & tags", Deps: []string{"contacts"}, Start: "crm"},
	{Key: "quotes", Label: "Quotes", Deps: []string{"base", "contacts", "products"}, Start: "quote"},
	{Key: "invoices", Label: "Invoices", Deps: []string{"base", "contacts", "products"}, Uses: []string{"quotes"}, Start: "invoice"},
	{Key: "property", Label: "Property management", Deps: []string{"contacts"}, Start: "property_management"},
	{Key: "events", Label: "Events & bookings", Deps: []string{"contacts"}, Start: "event"},
}

// ErrUnknownGroup rejects a selection naming no group.
var ErrUnknownGroup = errors.New("unknown seed group")

// groupSteps slices `steps` by each group's Start entity.
func groupSteps() (map[string][]step, error) {
	out := map[string][]step{}
	gi := -1
	for _, s := range steps {
		if gi+1 < len(AllGroups) && s.entity == AllGroups[gi+1].Start {
			gi++
		}
		if gi < 0 {
			return nil, fmt.Errorf("devseed: step %q comes before the first group", s.entity)
		}
		out[AllGroups[gi].Key] = append(out[AllGroups[gi].Key], s)
	}
	if gi != len(AllGroups)-1 {
		return nil, fmt.Errorf("devseed: group %q has no step starting with %q", AllGroups[gi+1].Key, AllGroups[gi+1].Start)
	}
	return out, nil
}

// prepare: a step building, indexing or analyzing a temp table other groups
// join. Every temp table is named seed_….
func (s step) prepare() bool {
	sql := strings.TrimSpace(s.sql)
	return strings.HasPrefix(sql, "CREATE TEMP TABLE") ||
		strings.HasPrefix(sql, "CREATE UNIQUE INDEX ON seed_") || strings.HasPrefix(sql, "ANALYZE seed_")
}

func markerKey(group string) string { return MarkerKey + "." + group }

// seededGroups reads the tenant's markers; the legacy whole-volume marker
// (before groups existed) counts as every group seeded.
func seededGroups(ctx context.Context, ex orm.Executor, tenant uuid.UUID) (map[string]bool, error) {
	rows, err := ex.Query(ctx, `SELECT key FROM app_settings WHERE tenant_id = $1 AND deleted_at IS NULL
		AND (key = $2 OR key LIKE $2 || '.%')`, tenant, MarkerKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		if key == MarkerKey {
			for _, g := range AllGroups {
				out[g.Key] = true
			}
			continue
		}
		out[strings.TrimPrefix(key, MarkerKey+".")] = true
	}
	return out, rows.Err()
}

// GroupStatus is a group and whether this tenant already seeded it.
type GroupStatus struct {
	Group
	Seeded bool `json:"seeded"`
}

// Groups lists the groups with the tenant's seeded state.
func Groups(ctx context.Context, ex orm.Executor, tenant uuid.UUID) ([]GroupStatus, error) {
	seeded, err := seededGroups(ctx, ex, tenant)
	if err != nil {
		return nil, err
	}
	out := make([]GroupStatus, 0, len(AllGroups))
	for _, g := range AllGroups {
		deps := g.Deps
		if deps == nil {
			deps = []string{}
		}
		g.Deps = deps
		out = append(out, GroupStatus{Group: g, Seeded: seeded[g.Key]})
	}
	return out, nil
}

// plan resolves a selection (nil/empty = every group) into the groups to
// seed now — the selection plus its dependencies, minus those already
// seeded — and the skipped groups whose prepare steps must still run.
func plan(selected []string, seeded map[string]bool) (seed, prepare map[string]bool, err error) {
	byKey := map[string]Group{}
	for _, g := range AllGroups {
		byKey[g.Key] = g
	}
	want := map[string]bool{}
	var add func(string) error
	add = func(key string) error {
		g, ok := byKey[key]
		if !ok {
			return fmt.Errorf("%w %q", ErrUnknownGroup, key)
		}
		if want[key] {
			return nil
		}
		want[key] = true
		for _, d := range g.Deps {
			if err := add(d); err != nil {
				return err
			}
		}
		return nil
	}
	if len(selected) == 0 {
		for _, g := range AllGroups {
			selected = append(selected, g.Key)
		}
	}
	for _, key := range selected {
		if err := add(key); err != nil {
			return nil, nil, err
		}
	}
	seed, prepare = map[string]bool{}, map[string]bool{}
	for key := range want {
		if !seeded[key] {
			seed[key] = true
		}
	}
	for key := range seed {
		g := byKey[key]
		for _, d := range slices.Concat(g.Deps, g.Uses) {
			if !seed[d] {
				prepare[d] = true
			}
		}
	}
	return seed, prepare, nil
}
