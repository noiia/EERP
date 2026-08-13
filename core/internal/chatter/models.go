// Package chatter owns a record's activity feed: a user-authored comment or
// an automatic summary of a form edit, anchored on (tenant, table, record) —
// the same shape internal/notebook already established for record-anchored
// content that doesn't belong on the generic CRUD surface. Unlike a notebook
// page (one user's own long-form note, editable/deletable), a chatter entry
// is append-only: no Update, no Delete — an activity log reads wrong if
// entries can quietly change after the fact.
package chatter

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// ChatterMessage is one entry in a record's feed. AuthorEmail is snapshotted
// at write time — Users carries no separate display-name column (the closest
// thing this schema has, per core/internal/settings' preferencesResponse
// doc comment), and snapshotting avoids an N+1 author lookup per feed read,
// the same choice Invoice.IssuerName already makes for its own snapshot.
type ChatterMessage struct {
	model.BaseModel
	TenantID    uuid.UUID `db:"tenant_id,index"`
	TableName   string    `db:"table_name"`
	RecordID    uuid.UUID `db:"record_id,index"`
	AuthorID    uuid.UUID `db:"author_id"`
	AuthorEmail string    `db:"author_email"`
	// Kind is "message" (a user posted a comment) or "log" (the frontend's
	// own summary of a form edit, posted the same way as a message — see
	// handler.go's Create). Both share one timeline; the frontend renders
	// them identically as "<author> : <body>", styling log entries muted.
	//
	// ponytail: Kind is client-declared, not verified against an actual
	// field diff — a determined caller could mislabel a message as a log.
	// Acceptable for a collaboration feed; would need real server-side
	// change-tracking to be an audit trail, which this isn't.
	Kind string `db:"kind"`
	Body string `db:"body"`
}
