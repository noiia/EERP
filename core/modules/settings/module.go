// Package settings registers the tenant settings table with the ORM registry.
// Import this package via core/modules/all to activate it.
package settings

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/internal/settings"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&settingsModule{})
}

type settingsModule struct{}

func (m *settingsModule) Name() string { return "settings" }

func (m *settingsModule) Register() error {
	// Registered for schema migration but kept OFF the generic HTTP CRUD surface:
	// settings are tenant-wide state written through dedicated, permission-gated
	// endpoints (see internal/settings.Handler), never the auto-generated API.
	return orm.Register[settings.AppSettings](
		orm.WithTableName("app_settings"),
		orm.WithExcluded(),
	)
}

// Migrate adds the (tenant_id, key) unique index the repository's upsert
// (ON CONFLICT) depends on — multi-column indexes are beyond what the
// struct-tag auto-migration can derive.
func (m *settingsModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_tenant_key
		ON app_settings (tenant_id, key)
	`); err != nil {
		return fmt.Errorf("settings: create unique index: %w", err)
	}
	return nil
}
