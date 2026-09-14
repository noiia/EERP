// Package pictures registers the core picture metadata table with the ORM
// registry. Import this package via core/modules/all to activate it.
package pictures

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/internal/pictures"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&picturesModule{})
}

type picturesModule struct{}

func (m *picturesModule) Name() string { return "pictures" }

func (m *picturesModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD surface:
	// picture rows are only reachable through the dedicated, tenant-pinned
	// handlers in internal/pictures — the generic API must never hand out object
	// keys or let a tenant enumerate another's uploads.
	return orm.Register[pictures.Picture](
		orm.WithTableName("picture"),
		orm.WithExcluded(),
	)
}

// Migrate adds the unique anchor index enforcing the service invariant of ONE
// picture per (tenant, table, record, field) — the picture-backed boolean
// contract (field true ⇔ picture exists) depends on it, and multi-column
// indexes are beyond what the struct-tag auto-migration can derive.
func (m *picturesModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS uq_picture_anchor
		ON picture (tenant_id, table_name, record_id, field)
	`); err != nil {
		return fmt.Errorf("pictures: create unique anchor index: %w", err)
	}
	return nil
}
