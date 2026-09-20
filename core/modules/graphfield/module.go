// Package graphfield registers the chart calculated-field table with the ORM
// registry. Import via core/modules/all to activate it.
package graphfield

import (
	"context"
	"fmt"

	"core/internal/graphfield"
	"core/internal/module"
	"core/orm"
)

func init() { module.RegisterGoModule(&graphFieldModule{}) }

type graphFieldModule struct{}

func (m *graphFieldModule) Name() string { return "graphfield" }

// Register keeps the table OFF the generic CRUD surface: role visibility and
// formula validation live in the dedicated handler in core/internal/graphfield.
func (m *graphFieldModule) Register() error {
	return orm.Register[graphfield.GraphField](orm.WithTableName("graph_field"), orm.WithExcluded())
}

// Migrate adds the unique (tenant, entity, key) index struct tags can't express.
// No deleted_at guard: rows are hard-deleted, so a removed key is reusable.
func (m *graphFieldModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_field_key
		ON graph_field (tenant_id, entity, field_key)`); err != nil {
		return fmt.Errorf("graphfield: create key index: %w", err)
	}
	return nil
}
