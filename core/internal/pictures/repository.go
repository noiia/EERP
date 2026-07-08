package pictures

import (
	"context"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is the tenant-pinned metadata store. Every query filters on the
// caller's tenant — a picture id from another tenant behaves exactly like a
// missing one (orm.ErrNotFound), so nothing leaks across tenants.
type Repository struct {
	pictures *orm.Repository[Picture]
	db       *orm.DB
}

// NewRepository wires the picture repository. Call once at startup — panics if
// the Picture struct tags are invalid.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{pictures: orm.MustRepo[Picture](db), db: db}
}

// Create inserts the metadata row and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, p Picture) (Picture, error) {
	return r.pictures.Create(ctx, p)
}

// Update rewrites the metadata row (the upload handler's replace path — the
// anchor keeps its id, only the object coordinates change). Callers resolve the
// row tenant-pinned first (FindByAnchor/FindInTenant), so id is already scoped.
func (r *Repository) Update(ctx context.Context, p Picture, id uuid.UUID) (Picture, error) {
	return r.pictures.Update(ctx, p, id)
}

// FindInTenant returns the picture by id, tenant-pinned.
func (r *Repository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Picture, error) {
	rows, err := r.pictures.FindAll(ctx,
		orm.Cond("id = $1", id), orm.Cond("tenant_id = $2", tenantID))
	if err != nil {
		return Picture{}, fmt.Errorf("pictures: find: %w", err)
	}
	if len(rows) == 0 {
		return Picture{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// FindByAnchor returns the picture attached to (table, record, field), or
// orm.ErrNotFound. One picture per anchor is the service's invariant.
func (r *Repository) FindByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID, field string) (Picture, error) {
	rows, err := r.pictures.FindAll(ctx,
		orm.Cond("tenant_id = $1", tenantID),
		orm.Cond("table_name = $2", table),
		orm.Cond("record_id = $3", recordID),
		orm.Cond("field = $4", field))
	if err != nil {
		return Picture{}, fmt.Errorf("pictures: find by anchor: %w", err)
	}
	if len(rows) == 0 {
		return Picture{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// Delete removes the metadata row (hard — Picture carries no soft-delete
// column: the object is gone from the bucket, a tombstone would lie).
func (r *Repository) Delete(ctx context.Context, tenantID, id uuid.UUID) error {
	if _, err := r.FindInTenant(ctx, tenantID, id); err != nil {
		return err
	}
	if _, err := r.pictures.Delete(ctx, id); err != nil {
		return fmt.Errorf("pictures: delete: %w", err)
	}
	return nil
}
