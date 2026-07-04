// Package settings owns tenant-scoped application settings (a key/value table
// off the generic CRUD surface) and the self-service preference endpoints. It
// exists so workspace-wide choices — like the default interface language — have
// a durable, tenant-isolated home that dedicated handlers control, instead of
// leaking auth-adjacent state onto the auto-generated API.
package settings

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// DefaultLocaleKey is the app_settings key holding the tenant's default
// interface language. An empty (or absent) value means the source language.
const DefaultLocaleKey = "i18n.default_locale"

// AppSettings is one tenant-scoped setting. (tenant_id, key) is unique — the
// settings module's Migrate creates the index — so writes are upserts.
type AppSettings struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	Key      string    `db:"key"`
	Value    string    `db:"value"`
}
