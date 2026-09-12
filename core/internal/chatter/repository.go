package chatter

import (
	"context"
	"fmt"
	"sort"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is the tenant-pinned message store. Every query filters on the
// caller's tenant — a message from another tenant behaves exactly like a
// missing one, so nothing leaks across tenants.
type Repository struct {
	messages *orm.Repository[ChatterMessage]
}

// NewRepository wires the chatter message repository. Call once at
// startup — panics if the ChatterMessage struct tags are invalid.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{messages: orm.MustRepo[ChatterMessage](db)}
}

// Create inserts a message row and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, m ChatterMessage) (ChatterMessage, error) {
	return r.messages.Create(ctx, m)
}

// ListByAnchor returns every message on (table, record) for the caller's
// tenant, newest first — a feed reads top-down from "most recent".
func (r *Repository) ListByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID) ([]ChatterMessage, error) {
	rows, err := r.messages.FindAll(ctx,
		orm.Cond("tenant_id = $1", tenantID),
		orm.Cond("table_name = $2", table),
		orm.Cond("record_id = $3", recordID))
	if err != nil {
		return nil, fmt.Errorf("chatter: list by anchor: %w", err)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt.After(rows[j].CreatedAt) })
	return rows, nil
}
