package reportlayout

import (
	"context"
	"fmt"

	"core/internal/company"
	"core/internal/module"
	"core/modules/reportlayout/internal"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&reportLayoutModule{})
}

type reportLayoutModule struct{}

func (m *reportLayoutModule) Name() string { return "reportlayout" }

func (m *reportLayoutModule) Register() error {
	return orm.Register[internal.ReportPageFormat]()
}

// Migrate backfills company_id on any report_page_format row left over from
// before multi-company shipped — same one-time, eager, boot-time posture as
// core/modules/settings' own Migrate() for app_settings, and the same
// shared helper (company.Repository.BackfillCompanyID).
func (m *reportLayoutModule) Migrate(ctx context.Context, db *orm.DB) error {
	if err := company.NewRepository(db).BackfillCompanyID(ctx, "report_page_format"); err != nil {
		return fmt.Errorf("reportlayout: %w", err)
	}
	return nil
}
