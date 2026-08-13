// Package chatter registers the chatter-message table with the ORM
// registry. Import this package via core/modules/all to activate it.
package chatter

import (
	"context"
	"fmt"

	"core/internal/chatter"
	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&chatterModule{})
}

type chatterModule struct{}

func (m *chatterModule) Name() string { return "chatter" }

func (m *chatterModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD
	// surface: messages are only reachable through the dedicated,
	// tenant-pinned handlers in core/internal/chatter — the generic API must
	// never let a tenant enumerate or write another tenant's (or another
	// entity's) messages without the anchor-scoping those handlers enforce.
	return orm.Register[chatter.ChatterMessage](
		orm.WithTableName("chatter_message"),
		orm.WithExcluded(),
	)
}

// Migrate adds the (tenant_id, table_name, record_id) index the List/Create
// handlers' anchor lookups depend on — a plain (non-unique) index, since
// MULTIPLE messages share one anchor. Beyond what the struct-tag
// auto-migration can derive. Mirrors core/modules/notebook/module.go exactly.
func (m *chatterModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE INDEX IF NOT EXISTS idx_chatter_message_anchor
		ON chatter_message (tenant_id, table_name, record_id)
	`); err != nil {
		return fmt.Errorf("chatter: create anchor index: %w", err)
	}
	return nil
}
