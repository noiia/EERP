package crud

import (
	"context"
	"fmt"
	"time"

	"core/orm/internal/registry"

	"github.com/google/uuid"
)

// ListFilter carries pagination parameters for list queries.
type ListFilter struct {
	Page     int
	PageSize int
}

// repoLayer is the interface Service requires from the repository layer.
// Defined at the call-site (here) per Go convention — not in the repository.
type repoLayer interface {
	FindAll(ctx context.Context, page, pageSize int) ([]map[string]any, int, error)
	FindByID(ctx context.Context, id any) (map[string]any, error)
	Create(ctx context.Context, data map[string]any) (map[string]any, error)
	Update(ctx context.Context, id any, data map[string]any) (map[string]any, error)
	Delete(ctx context.Context, id any) error
	Restore(ctx context.Context, id any) (map[string]any, error)
}

// Service adds business-logic guardrails on top of the raw repository:
//   - Injects server-side values (id, created_at, updated_at) on create.
//   - Always updates updated_at on mutations.
//   - Guards Restore calls when the table has no soft-delete support.
type Service struct {
	repo repoLayer
	meta registry.TableMeta
}

// NewService constructs a Service wrapping the given repository.
func NewService(repo *Repository, meta registry.TableMeta) *Service {
	return &Service{repo: repo, meta: meta}
}

// List returns a paginated list and total count.
func (s *Service) List(ctx context.Context, f ListFilter) ([]map[string]any, int, error) {
	return s.repo.FindAll(ctx, f.Page, f.PageSize)
}

// GetByID returns the row with the given id, excluding soft-deleted rows.
func (s *Service) GetByID(ctx context.Context, id any) (map[string]any, error) {
	return s.repo.FindByID(ctx, id)
}

// Create injects server-generated values and inserts a new row.
func (s *Service) Create(ctx context.Context, data map[string]any) (map[string]any, error) {
	if s.meta.HasField("id") {
		if _, exists := data["id"]; !exists {
			data["id"] = uuid.New()
		}
	}
	now := time.Now()
	if s.meta.HasField("created_at") {
		data["created_at"] = now
	}
	if s.meta.HasField("updated_at") {
		data["updated_at"] = now
	}

	return s.repo.Create(ctx, data)
}

// Update injects updated_at and persists the supplied fields.
func (s *Service) Update(ctx context.Context, id any, data map[string]any) (map[string]any, error) {
	if s.meta.HasField("updated_at") {
		data["updated_at"] = time.Now()
	}
	return s.repo.Update(ctx, id, data)
}

// Delete removes the row (soft or hard depending on table configuration).
func (s *Service) Delete(ctx context.Context, id any) error {
	return s.repo.Delete(ctx, id)
}

// Restore un-deletes a soft-deleted row. Returns an error immediately if the
// table does not support soft delete — callers should guard with meta.SoftDelete.
func (s *Service) Restore(ctx context.Context, id any) (map[string]any, error) {
	if !s.meta.SoftDelete {
		return nil, fmt.Errorf("service: restore: table %s does not support soft delete", s.meta.TableName)
	}
	return s.repo.Restore(ctx, id)
}
