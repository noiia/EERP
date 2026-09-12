package attachments

import (
	"context"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is the tenant-pinned metadata store — mirrors
// internal/pictures/repository.go exactly, scoped to Attachment instead of
// Picture. Every query filters on the caller's tenant — an attachment id
// from another tenant behaves exactly like a missing one (orm.ErrNotFound),
// so nothing leaks across tenants.
type Repository struct {
	attachments *orm.Repository[Attachment]
	db          *orm.DB
}

// NewRepository wires the attachment repository. Call once at startup —
// panics if the Attachment struct tags are invalid.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{attachments: orm.MustRepo[Attachment](db), db: db}
}

// Create inserts the metadata row and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, a Attachment) (Attachment, error) {
	return r.attachments.Create(ctx, a)
}

// Update rewrites the metadata row (the upload handler's replace path — the
// anchor keeps its id, only the object coordinates change). Callers resolve
// the row tenant-pinned first (FindByAnchor/FindInTenant), so id is already
// scoped.
func (r *Repository) Update(ctx context.Context, a Attachment, id uuid.UUID) (Attachment, error) {
	return r.attachments.Update(ctx, a, id)
}

// FindInTenant returns the attachment by id, tenant-pinned.
func (r *Repository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Attachment, error) {
	rows, err := r.attachments.FindAll(ctx,
		orm.Cond("id = $1", id), orm.Cond("tenant_id = $2", tenantID))
	if err != nil {
		return Attachment{}, fmt.Errorf("attachments: find: %w", err)
	}
	if len(rows) == 0 {
		return Attachment{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// FindByAnchor returns the attachment on (table, record, field), or
// orm.ErrNotFound. One attachment per anchor is the service's invariant.
func (r *Repository) FindByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID, field string) (Attachment, error) {
	rows, err := r.attachments.FindAll(ctx,
		orm.Cond("tenant_id = $1", tenantID),
		orm.Cond("table_name = $2", table),
		orm.Cond("record_id = $3", recordID),
		orm.Cond("field = $4", field))
	if err != nil {
		return Attachment{}, fmt.Errorf("attachments: find by anchor: %w", err)
	}
	if len(rows) == 0 {
		return Attachment{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// Delete removes the metadata row. HARD delete: Attachment deliberately
// carries no soft-delete column (see the model comment) — a tombstone would
// keep occupying the unique anchor index while pointing at bytes gone from
// the bucket.
func (r *Repository) Delete(ctx context.Context, tenantID, id uuid.UUID) error {
	if _, err := r.FindInTenant(ctx, tenantID, id); err != nil {
		return err
	}
	if _, err := r.attachments.Delete(ctx, id); err != nil {
		return fmt.Errorf("attachments: delete: %w", err)
	}
	return nil
}
