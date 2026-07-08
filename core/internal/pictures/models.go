// Package pictures owns user-uploaded binary content (pictures, signatures):
// the bytes live in S3-compatible object storage (Garage in dev), the metadata
// in the picture table — one row per (tenant, table, record, field), which is
// exactly the contract picture-backed boolean fields rely on: field true ⇔ a
// picture row exists (docs/roadmaps/field-widgets.md, Phase 3). The table stays
// off the generic CRUD surface; the dedicated, tenant-pinned handlers here are
// the only HTTP path to it.
package pictures

import (
	"time"

	"github.com/google/uuid"
)

// Picture is one stored image's metadata. ObjectKey locates the bytes in the
// bucket; (TenantID, TableName, RecordID, Field) locates the picture from the
// owning record's side.
//
// Deliberately NOT model.BaseModel: that base carries `deleted_at,softdelete`,
// which would make Delete a soft delete — and a picture tombstone breaks the
// service twice over. It still occupies uq_picture_anchor (the next upload to
// the anchor 23505s while FindByAnchor, which filters soft-deleted rows, sees
// nothing), and it points at bytes already removed from the bucket. Deletes
// here must be hard; the row's existence IS the field's truth.
type Picture struct {
	ID        uuid.UUID `db:"id,pk"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
	TenantID  uuid.UUID `db:"tenant_id,index"`
	TableName string    `db:"table_name"`
	RecordID  uuid.UUID `db:"record_id"`
	Field     string    `db:"field"`
	ObjectKey string    `db:"object_key"`
	Mime      string    `db:"mime"`
	Size      int64     `db:"size"`
}
