// Package settings registers the tenant settings table with the ORM registry.
// Import this package via core/modules/all to activate it.
package settings

import (
	"context"
	"fmt"

	"core/internal/company"
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

// Migrate adds the (tenant_id, company_id, key) unique index the
// repository's upsert (ON CONFLICT) depends on — multi-column indexes are
// beyond what the struct-tag auto-migration can derive. Runs once, at boot,
// before the HTTP server starts listening (core/cmd/app/main.go's
// moduleRuntime.Boot()) — never concurrently with a live request.
//
// Every pre-existing row is backfilled to its tenant's (lazily-created)
// default company (company.Repository.BackfillCompanyID) BEFORE the new
// 3-column index replaces the old 2-column one, so uniqueness is never
// briefly unenforced for a live column. This repo has no multi-replica
// rolling-deploy tooling today (confirmed via main.go/compose.yml), so a
// single atomic Migrate() is safe; a real expand/contract split would only
// be needed if that changes later.
func (m *settingsModule) Migrate(ctx context.Context, db *orm.DB) error {
	if err := company.NewRepository(db).BackfillCompanyID(ctx, "app_settings"); err != nil {
		return fmt.Errorf("settings: %w", err)
	}

	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_tenant_company_key
		ON app_settings (tenant_id, company_id, key)
	`); err != nil {
		return fmt.Errorf("settings: create unique index: %w", err)
	}
	if _, err := db.Exec(ctx, `
		DROP INDEX IF EXISTS uq_app_settings_tenant_key
	`); err != nil {
		return fmt.Errorf("settings: drop old unique index: %w", err)
	}
	return nil
}
