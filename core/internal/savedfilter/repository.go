package savedfilter

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrDuplicateSavedFilterName is returned by Create/Update when the name is
// already used within the same visibility scope (private: per user+entity;
// shared: per tenant+entity) — the two partial unique indexes
// core/modules/savedfilter/module.go's Migrate() creates, so the Postgres
// 23505 violation is mapped here rather than surfacing as a raw 500.
var ErrDuplicateSavedFilterName = errors.New("saved_filter: name already used in this scope")

const pgUniqueViolation = "23505"

func mapWriteErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
		return ErrDuplicateSavedFilterName
	}
	return err
}

// Repository is the tenant-pinned saved-filter store. Every query filters on
// the caller's tenant — a filter id from another tenant behaves exactly like
// a missing one (orm.ErrNotFound), so nothing leaks across tenants.
type Repository struct {
	filters *orm.Repository[SavedFilter]
}

// NewRepository wires the saved-filter repository. Call once at startup —
// panics if the SavedFilter struct tags are invalid.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{filters: orm.MustRepo[SavedFilter](db)}
}

// Create inserts a saved filter and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, sf SavedFilter) (SavedFilter, error) {
	created, err := r.filters.Create(ctx, sf)
	if err != nil {
		return SavedFilter{}, mapWriteErr(err)
	}
	return created, nil
}

// Update rewrites a saved filter row (rename/reconfigure/reshare). Callers
// resolve the row tenant-pinned first (FindInTenant), so id is already scoped.
func (r *Repository) Update(ctx context.Context, sf SavedFilter, id uuid.UUID) (SavedFilter, error) {
	updated, err := r.filters.Update(ctx, sf, id)
	if err != nil {
		return SavedFilter{}, mapWriteErr(err)
	}
	return updated, nil
}

// FindInTenant returns the saved filter by id, tenant-pinned.
func (r *Repository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (SavedFilter, error) {
	// Each Cond's own $1 is rebased to its real position in the combined
	// WHERE by query.Condition.rebase — every condition here is independent
	// and always starts counting its own placeholders at $1.
	rows, err := r.filters.FindAll(ctx,
		orm.Cond("id = $1", id), orm.Cond("tenant_id = $1", tenantID))
	if err != nil {
		return SavedFilter{}, fmt.Errorf("saved_filter: find: %w", err)
	}
	if len(rows) == 0 {
		return SavedFilter{}, orm.ErrNotFound
	}
	return rows[0], nil
}

// ListVisible returns every saved filter on entity the caller may use in
// that entity's search bar: their OWN filters (private or shared) plus every
// OTHER user's shared filter. This is the one query the generic CRUD
// surface's AND-only .Where() chain cannot express — user_id = $3 OR
// shared = true is a real OR, built here with orm.Cond's raw-SQL escape
// hatch (the documented way to express OR in this ORM).
func (r *Repository) ListVisible(ctx context.Context, tenantID, userID uuid.UUID, entity string) ([]SavedFilter, error) {
	rows, err := r.filters.FindAll(ctx,
		orm.Cond("tenant_id = $1", tenantID),
		orm.Cond("entity = $1", entity),
		orm.Cond("(user_id = $1 OR shared = true)", userID),
	)
	if err != nil {
		return nil, fmt.Errorf("saved_filter: list visible: %w", err)
	}
	return rows, nil
}

// Delete soft-deletes the saved-filter row.
func (r *Repository) Delete(ctx context.Context, tenantID, id uuid.UUID) error {
	if _, err := r.FindInTenant(ctx, tenantID, id); err != nil {
		return err
	}
	if _, err := r.filters.Delete(ctx, id); err != nil {
		return fmt.Errorf("saved_filter: delete: %w", err)
	}
	return nil
}
