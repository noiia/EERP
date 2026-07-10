// Package notebook owns runtime, per-record notebook pages — the third
// category ADR-007 names alongside descriptor structure and workspace
// app_settings: a user adding a "Meeting notes" tab to ONE crm record, not a
// build-time layout change (ADR-005) and not a tenant-wide preference
// (ADR-006). One row per page, anchored on (tenant, table, record), the same
// shape internal/pictures already established for record-anchored content —
// this package mirrors it, minus the object-storage leg, since a page's
// content is text and lives in the row itself. The table stays off the
// generic CRUD surface; the dedicated, tenant-pinned handler here is the only
// HTTP path to it.
package notebook

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// NotebookPage is one user-created page anchored on (tenant, table, record).
// Declared pages (a `page` node inside a form's `notebook` layout node) are
// descriptor structure and never touch this table — only RUNTIME pages a user
// adds at the record level live here.
//
// Position ships in v1 storage but not v1 UI: pages append in creation order
// (Position = current page count for the anchor), so a future reorder feature
// never needs a migration — the same future-proofing posture Tile.hidden took
// in docs/roadmaps/list-view-modes.md.
type NotebookPage struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id,index"`
	TableName string    `db:"table_name"`
	RecordID  uuid.UUID `db:"record_id,index"`
	Title     string    `db:"title"`
	Position  int       `db:"position"`
	Content   string    `db:"content"`
}
