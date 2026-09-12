package company

import (
	"context"
	"fmt"

	"core/internal/company"
	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&companyModule{})
}

type companyModule struct{}

func (m *companyModule) Name() string { return "company" }

func (m *companyModule) Register() error {
	return orm.Register[company.Company]()
}

// Migrate creates the partial unique index company.Repository's bootstrap
// (ON CONFLICT (tenant_id) WHERE is_default) depends on — multi-column/
// partial indexes are beyond what struct-tag auto-migration can derive.
func (m *companyModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS uq_company_tenant_default
		ON company (tenant_id) WHERE is_default
	`); err != nil {
		return fmt.Errorf("company: create default-company index: %w", err)
	}
	return nil
}
