package notebook

import (
	"context"
	"fmt"
	"sort"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is the tenant-pinned page store. Every query filters on the
// caller's tenant — a page id from another tenant behaves exactly like a
// missing one (orm.ErrNotFound), so nothing leaks across tenants.
type Repository struct {
	pages *orm.Repository[NotebookPage]
}

// NewRepository wires the notebook page repository. Call once at startup —
// panics if the NotebookPage struct tags are invalid.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{pages: orm.MustRepo[NotebookPage](db)}
}

// Create inserts a page row and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, p NotebookPage) (NotebookPage, error) {
	return r.pages.Create(ctx, p)
}

// Update rewrites a page row (title/content edits). Callers resolve the row
// tenant-pinned first (FindInTenant), so id is already scoped.
func (r *Repository) Update(ctx context.Context, p NotebookPage, id uuid.UUID) (NotebookPage, error) {
	return r.pages.Update(ctx, p, id)
}

// FindInTenant returns the page by id, tenant-pinned.
func (r *Repository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (NotebookPage, error) {
	rows, err := r.pages.FindAll(ctx,
		orm.Cond("id = $1", id), orm.Cond("tenant_id = $2", tenantID))
	if err != nil {
		return NotebookPage{}, fmt.Errorf("notebook: find: %w", err)
	}
	if len(rows) == 0 {
		return NotebookPage{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// ListByAnchor returns every page on (table, record) for the caller's tenant,
// ordered by Position (creation order in v1 — nothing reorders yet).
func (r *Repository) ListByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID) ([]NotebookPage, error) {
	rows, err := r.pages.FindAll(ctx,
		orm.Cond("tenant_id = $1", tenantID),
		orm.Cond("table_name = $2", table),
		orm.Cond("record_id = $3", recordID))
	if err != nil {
		return nil, fmt.Errorf("notebook: list by anchor: %w", err)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Position < rows[j].Position })
	return rows, nil
}

// Delete soft-deletes the page row (NotebookPage carries model.BaseModel's
// softdelete column, unlike Picture — a tombstoned page is harmless: no
// unique anchor index depends on its absence).
func (r *Repository) Delete(ctx context.Context, tenantID, id uuid.UUID) error {
	if _, err := r.FindInTenant(ctx, tenantID, id); err != nil {
		return err
	}
	if _, err := r.pages.Delete(ctx, id); err != nil {
		return fmt.Errorf("notebook: delete: %w", err)
	}
	return nil
}
