// Package savedfilter registers the saved-filter table with the ORM
// registry. Import this package via core/modules/all to activate it.
package savedfilter

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/internal/savedfilter"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&savedFilterModule{})
}

type savedFilterModule struct{}

func (m *savedFilterModule) Name() string { return "savedfilter" }

func (m *savedFilterModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD
	// surface: "private OR shared" visibility and the owner-only
	// rename/delete check are enforced by the dedicated handler in
	// core/internal/savedfilter, which the generic column-whitelist surface
	// has no way to express.
	return orm.Register[savedfilter.SavedFilter](
		orm.WithTableName("saved_filter"),
		orm.WithExcluded(),
	)
}

// Migrate adds the two partial unique indexes a saved filter's name needs —
// one scope for private filters (per user+entity), one for shared filters
// (per tenant+entity) — beyond what struct-tag auto-migration can derive
// (no unique-constraint support at all, and these two scopes are genuinely
// independent axes, not one column pair). Mirrors
// core/modules/auth/module.go's idx_roles_tenant_technical_name: a
// hand-written partial unique index, WHERE-guarded on deleted_at IS NULL so
// a soft-deleted filter doesn't permanently squat a name.
func (m *savedFilterModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_filter_private_name
		ON saved_filter (tenant_id, user_id, entity, name)
		WHERE shared = false AND deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("savedfilter: create private-name index: %w", err)
	}
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_filter_shared_name
		ON saved_filter (tenant_id, entity, name)
		WHERE shared = true AND deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("savedfilter: create shared-name index: %w", err)
	}
	return nil
}
