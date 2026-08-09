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

// NumberFormatKey is the app_settings key holding the tenant's number display
// format, stored as JSON: {"decimal_separator":",","thousands_separator":" "}.
// Absent (or unparsable) means the frontend's built-in default (1,234.56).
const NumberFormatKey = "format.number"

// ViewFieldsKey returns the app_settings key holding entity's Kanban/Calendar
// field configuration (docs/roadmaps/list-view-modes.md), stored as JSON:
// {"kanban_status_field":"status","calendar_date_field":"due_date"}. One key
// per entity — unlike DefaultLocaleKey/NumberFormatKey, which are tenant-wide
// singletons, this setting is inherently per-entity, so the key is computed
// rather than a fixed constant. Absent means neither mode is configured yet.
func ViewFieldsKey(entity string) string {
	return "views." + entity + ".fields"
}

// ViewGraphKey returns the app_settings key holding entity's Graph mode tile
// layout (docs/roadmaps/list-view-modes.md, Phase 4), stored as JSON:
// {"tiles":[{"id":...,"x":0,"y":0,"w":6,"h":6,"type":"stat","config":{}}]}.
// Same per-entity shape as ViewFieldsKey; absent means an empty canvas.
func ViewGraphKey(entity string) string {
	return "views." + entity + ".graph"
}

// PictureSizeKey is the app_settings key holding the workspace-wide ("Base")
// default box size for boolean/picture widgets, stored as JSON:
// {"width":160,"height":96}. Absent means the frontend's own hardcoded
// default (still below a field's own widgetOptions in precedence — see
// core-front/packages/core-front/src/views/picture-widgets.tsx).
const PictureSizeKey = "widgets.picture_size"

// ModulePictureSizeKey returns the app_settings key holding a specific
// module's OWN override of PictureSizeKey (Settings -> Apps). Absent means
// "inherit the Base value" — the frontend resolves the cascade, this key
// alone never encodes "unset vs falls back to X", same posture as
// ViewFieldsKey/ViewGraphKey.
func ModulePictureSizeKey(module string) string {
	return "apps." + module + ".widgets.picture_size"
}

// ReportsLayoutKey is the app_settings key holding the workspace-wide PDF
// report letterhead: a footer and an address text block stamped on every
// generated report (docs/adr/ADR-011's Reports settings subsection), stored
// as JSON: {"footer":"...","address":"..."}. Absent means both are empty —
// the print pipeline simply renders no chrome, not an error. A
// report_page_format row (core/modules/reportlayout) may override either
// field per format; this key only ever holds the global default.
const ReportsLayoutKey = "reports.layout"

// AppSettings is one tenant-scoped setting. (tenant_id, key) is unique — the
// settings module's Migrate creates the index — so writes are upserts.
type AppSettings struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	Key      string    `db:"key"`
	Value    string    `db:"value"`
}
