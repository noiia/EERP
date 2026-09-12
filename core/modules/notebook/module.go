// Package notebook registers the runtime notebook-pages table with the ORM
// registry. Import this package via core/modules/all to activate it.
package notebook

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/internal/notebook"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&notebookModule{})
}

type notebookModule struct{}

func (m *notebookModule) Name() string { return "notebook" }

func (m *notebookModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD
	// surface: pages are only reachable through the dedicated, tenant-pinned
	// handlers in internal/notebook — the generic API must never let a
	// tenant enumerate or write another tenant's (or another entity's) pages
	// without the anchor-scoping those handlers enforce.
	return orm.Register[notebook.NotebookPage](
		orm.WithTableName("notebook_page"),
		orm.WithExcluded(),
	)
}

// Migrate adds the (tenant_id, table_name, record_id) index the List/Create
// handlers' anchor lookups depend on — a plain (non-unique) index, since
// MULTIPLE pages share one anchor, unlike the picture service's one-per-anchor
// invariant. Beyond what the struct-tag auto-migration can derive.
func (m *notebookModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE INDEX IF NOT EXISTS idx_notebook_page_anchor
		ON notebook_page (tenant_id, table_name, record_id)
	`); err != nil {
		return fmt.Errorf("notebook: create anchor index: %w", err)
	}
	return nil
}
