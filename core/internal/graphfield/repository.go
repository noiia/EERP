package graphfield

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrDuplicateKey maps the (tenant, entity, key) unique-index violation.
var ErrDuplicateKey = errors.New("graph_field: key already used on this entity")

// Repository is the tenant-pinned calculated-field store.
type Repository struct{ fields *orm.Repository[GraphField] }

func NewRepository(db *orm.DB) *Repository {
	return &Repository{fields: orm.MustRepo[GraphField](db)}
}

func (r *Repository) Create(ctx context.Context, f GraphField) (GraphField, error) {
	created, err := r.fields.Create(ctx, f)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return GraphField{}, ErrDuplicateKey
	}
	return created, err
}

// Update rewrites label/formula/roles/dated; the key never changes, since tiles reference it.
func (r *Repository) Update(ctx context.Context, f GraphField, id uuid.UUID) (GraphField, error) {
	return r.fields.Update(ctx, f, id)
}

func (r *Repository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (GraphField, error) {
	rows, err := r.fields.FindAll(ctx, orm.Cond("id = $1", id), orm.Cond("tenant_id = $1", tenantID))
	if err != nil {
		return GraphField{}, fmt.Errorf("graph_field: find: %w", err)
	}
	if len(rows) == 0 {
		return GraphField{}, orm.ErrNotFound
	}
	return rows[0], nil
}

func (r *Repository) List(ctx context.Context, tenantID uuid.UUID, entity string) ([]GraphField, error) {
	return r.fields.FindAll(ctx, orm.Cond("tenant_id = $1", tenantID), orm.Cond("entity = $1", entity))
}

// Delete is a HARD delete (orm HardDelete, not the soft-delete BaseModel
// default): the row goes, and its index entries with it, so the key is
// immediately reusable — tiles that still reference it just read 0.
func (r *Repository) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := r.fields.HardDelete(ctx, id); err != nil {
		return fmt.Errorf("graph_field: delete: %w", err)
	}
	return nil
}
