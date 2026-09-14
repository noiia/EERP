// Package presence registers the user_presence table with the ORM registry
// for schema migration. Import this package via core/modules/all to activate
// it. Mirrors core/modules/chatter/module.go's shape exactly.
package presence

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/internal/presence"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&presenceModule{})
}

type presenceModule struct{}

func (m *presenceModule) Name() string { return "presence" }

func (m *presenceModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD
	// surface: presence is only reachable through the dedicated handler in
	// core/internal/presence, which resolves the caller's own row from the
	// auth identity rather than an :id path param.
	return orm.Register[presence.UserPresence](
		orm.WithTableName("user_presence"),
		orm.WithExcluded(),
	)
}

// Migrate adds the uniqueness constraint struct tags can't express — one
// presence row per (tenant, user), same reasoning as roles(tenant_id,
// technical_name) and chatter's own anchor index.
func (m *presenceModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_user_presence_tenant_user
		ON user_presence (tenant_id, user_id)
	`); err != nil {
		return fmt.Errorf("presence: create tenant/user unique index: %w", err)
	}
	return nil
}
