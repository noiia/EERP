// Package attachments registers the core attachment metadata table with the
// ORM registry — mirrors core/modules/pictures/module.go exactly, scoped to
// internal/attachments.Attachment. Import this package via core/modules/all
// to activate it.
package attachments

import (
	"context"
	"fmt"

	"core/internal/attachments"
	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&attachmentsModule{})
}

type attachmentsModule struct{}

func (m *attachmentsModule) Name() string { return "attachments" }

func (m *attachmentsModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD
	// surface: attachment rows are only reachable through the dedicated,
	// tenant-pinned handlers in internal/attachments — the generic API must
	// never hand out object keys or let a tenant enumerate another's uploads.
	return orm.Register[attachments.Attachment](
		orm.WithTableName("attachment"),
		orm.WithExcluded(),
	)
}

// Migrate adds the unique anchor index enforcing the service invariant of
// ONE attachment per (tenant, table, record, field) — the file-backed
// boolean contract (field true ⇔ attachment exists) depends on it, and
// multi-column indexes are beyond what the struct-tag auto-migration can
// derive. Mirrors pictures' own uq_picture_anchor index.
func (m *attachmentsModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS uq_attachment_anchor
		ON attachment (tenant_id, table_name, record_id, field)
	`); err != nil {
		return fmt.Errorf("attachments: create unique anchor index: %w", err)
	}
	return nil
}
