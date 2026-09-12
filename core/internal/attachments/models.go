// Package attachments owns user-uploaded ARBITRARY binary content (invoices,
// receipts, proofs of purchase — anything a `boolean/file` field needs to
// store) — the non-image sibling of internal/pictures. The bytes live in the
// same S3-compatible object storage (Garage in dev, pictures.NewS3Store
// reused verbatim), the metadata in the attachment table — one row per
// (tenant, table, record, field), the exact contract file-backed boolean
// fields rely on: field true ⇔ an attachment row exists. The table stays off
// the generic CRUD surface; the dedicated, tenant-pinned handlers here are
// the only HTTP path to it.
//
// Split from pictures rather than folding in because the two diverge on real
// invariants: pictures whitelist image/png|jpeg|webp and are never offered as
// a named download (they render as <img>); attachments accept any file type
// and MUST round-trip the uploader's original filename (Content-Disposition
// on download) — a PDF invoice saved as a random UUID with no name is not a
// usable download.
package attachments

import (
	"time"

	"github.com/google/uuid"
)

// Attachment is one stored file's metadata. ObjectKey locates the bytes in
// the bucket; (TenantID, TableName, RecordID, Field) locates it from the
// owning record's side, exactly like pictures.Picture.
//
// Deliberately NOT model.BaseModel — same reasoning as Picture: a softdelete
// tombstone would keep occupying the anchor's unique index while pointing at
// bytes already removed from the bucket. Deletes here must be hard.
type Attachment struct {
	ID        uuid.UUID `db:"id,pk"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
	TenantID  uuid.UUID `db:"tenant_id,index"`
	TableName string    `db:"table_name"`
	RecordID  uuid.UUID `db:"record_id"`
	Field     string    `db:"field"`
	ObjectKey string    `db:"object_key"`
	// Filename is the uploader's original name (e.g. "invoice-2026.pdf") —
	// pictures.Picture has no equivalent since a picture is never offered as
	// a named download, only rendered inline as <img>. Round-tripped as the
	// GET response's Content-Disposition filename.
	Filename string `db:"filename"`
	Mime     string `db:"mime"`
	Size     int64  `db:"size"`
}
