// Package website is the public website's page model: pages staff compose
// from blocks in the ERP (Website app), served anonymously through
// /api/v1/public (ADR-024).
package website

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func init() {
	module.RegisterGoModule(&websiteModule{})
}

// Optional columns are pointers: the generic CRUD layer requires every
// non-pointer column on create.
// WebsitePage is one public page. Slug "" is the home page. Layout is the
// ordered block grid (JSONB) — validated by ValidatePageBody, rendered by
// core-front's website blocks.
type WebsitePage struct {
	model.BaseModel
	TenantID       uuid.UUID         `db:"tenant_id"`
	Slug           string            `db:"slug" json:"slug"`
	Title          string            `db:"title" json:"title"`
	SEODescription *string           `db:"seo_description" json:"seo_description"`
	Published      *bool             `db:"published" json:"published"`
	InMenu         *bool             `db:"in_menu" json:"in_menu"`
	MenuSequence   *int              `db:"menu_sequence" json:"menu_sequence"`
	Layout         *[]map[string]any `db:"layout" json:"layout"`
}

type websiteModule struct{}

func (m *websiteModule) Name() string { return "website" }

func (m *websiteModule) Register() error {
	return orm.Register[WebsitePage](
		orm.WithTableName("website_page"),
		orm.WithPublicFields("slug", "title", "seo_description", "in_menu", "menu_sequence", "layout"),
	)
}

// Migrate adds the per-tenant unique slug (struct tags can't express one).
func (m *websiteModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_website_page_tenant_slug
		ON website_page (tenant_id, slug) WHERE deleted_at IS NULL`); err != nil {
		return fmt.Errorf("website: create slug index: %w", err)
	}
	return nil
}
