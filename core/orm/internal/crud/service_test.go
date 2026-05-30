package crud_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"core/orm/internal/crud"
	"core/orm/internal/registry"
	"core/orm/model"
)

// ── test fixtures ─────────────────────────────────────────────────────────────

type softItem struct {
	model.BaseModel
	Label string `db:"label"`
}

type hardItem struct {
	ID   int    `db:"id,pk"`
	Code string `db:"code"`
}

// softMeta registers softItem and returns its TableMeta.
// Re-registration is idempotent — previous entries are overwritten.
func softMeta() registry.TableMeta {
	_ = registry.Register[softItem]()
	m, _ := registry.Get("soft_item")
	return m
}

func hardMeta() registry.TableMeta {
	_ = registry.Register[hardItem]()
	m, _ := registry.Get("hard_item")
	return m
}

// ── mock repository ───────────────────────────────────────────────────────────

type mockRepo struct {
	findAll  func(ctx context.Context, page, pageSize int) ([]map[string]any, int, error)
	findByID func(ctx context.Context, id any) (map[string]any, error)
	create   func(ctx context.Context, data map[string]any) (map[string]any, error)
	update   func(ctx context.Context, id any, data map[string]any) (map[string]any, error)
	del      func(ctx context.Context, id any) error
	restore  func(ctx context.Context, id any) (map[string]any, error)
}

func (m *mockRepo) FindAll(ctx context.Context, page, pageSize int) ([]map[string]any, int, error) {
	if m.findAll != nil {
		return m.findAll(ctx, page, pageSize)
	}
	return nil, 0, nil
}
func (m *mockRepo) FindByID(ctx context.Context, id any) (map[string]any, error) {
	if m.findByID != nil {
		return m.findByID(ctx, id)
	}
	return nil, nil
}
func (m *mockRepo) Create(ctx context.Context, data map[string]any) (map[string]any, error) {
	if m.create != nil {
		return m.create(ctx, data)
	}
	return data, nil
}
func (m *mockRepo) Update(ctx context.Context, id any, data map[string]any) (map[string]any, error) {
	if m.update != nil {
		return m.update(ctx, id, data)
	}
	return data, nil
}
func (m *mockRepo) Delete(ctx context.Context, id any) error {
	if m.del != nil {
		return m.del(ctx, id)
	}
	return nil
}
func (m *mockRepo) Restore(ctx context.Context, id any) (map[string]any, error) {
	if m.restore != nil {
		return m.restore(ctx, id)
	}
	return map[string]any{}, nil
}

// ── List ──────────────────────────────────────────────────────────────────────

func TestService_List_PaginationPassedThrough(t *testing.T) {
	var gotPage, gotSize int
	repo := &mockRepo{
		findAll: func(_ context.Context, page, pageSize int) ([]map[string]any, int, error) {
			gotPage, gotSize = page, pageSize
			return nil, 0, nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	svc.List(context.Background(), crud.ListFilter{Page: 3, PageSize: 15}) //nolint:errcheck

	if gotPage != 3 || gotSize != 15 {
		t.Errorf("got page=%d size=%d, want 3/15", gotPage, gotSize)
	}
}

// ── Create ────────────────────────────────────────────────────────────────────

func TestService_Create_InjectsID(t *testing.T) {
	var created map[string]any
	repo := &mockRepo{
		create: func(_ context.Context, data map[string]any) (map[string]any, error) {
			created = data
			return data, nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	svc.Create(context.Background(), map[string]any{"label": "x"}) //nolint:errcheck

	if _, ok := created["id"]; !ok {
		t.Error("Create should inject 'id' when not provided")
	}
}

func TestService_Create_InjectsTimestamps(t *testing.T) {
	var created map[string]any
	repo := &mockRepo{
		create: func(_ context.Context, data map[string]any) (map[string]any, error) {
			created = data
			return data, nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	svc.Create(context.Background(), map[string]any{"label": "x"}) //nolint:errcheck

	if _, ok := created["created_at"]; !ok {
		t.Error("Create should inject 'created_at'")
	}
	if _, ok := created["updated_at"]; !ok {
		t.Error("Create should inject 'updated_at'")
	}
}

func TestService_Create_DoesNotOverwriteProvidedID(t *testing.T) {
	var created map[string]any
	repo := &mockRepo{
		create: func(_ context.Context, data map[string]any) (map[string]any, error) {
			created = data
			return data, nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())

	existing := "pre-set-id"
	svc.Create(context.Background(), map[string]any{"id": existing, "label": "x"}) //nolint:errcheck

	if got, _ := created["id"].(string); got != existing {
		t.Errorf("Create must not overwrite caller-provided id: got %v", created["id"])
	}
}

// ── Update ────────────────────────────────────────────────────────────────────

func TestService_Update_InjectsUpdatedAt(t *testing.T) {
	before := time.Now()
	var updated map[string]any
	repo := &mockRepo{
		update: func(_ context.Context, _ any, data map[string]any) (map[string]any, error) {
			updated = data
			return data, nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	svc.Update(context.Background(), "id-1", map[string]any{"label": "y"}) //nolint:errcheck

	ts, ok := updated["updated_at"].(time.Time)
	if !ok {
		t.Fatalf("updated_at should be time.Time, got %T", updated["updated_at"])
	}
	if ts.Before(before) {
		t.Error("updated_at should be >= now at call time")
	}
}

// ── Delete ────────────────────────────────────────────────────────────────────

func TestService_Delete_DelegatesToRepo(t *testing.T) {
	called := false
	repo := &mockRepo{
		del: func(_ context.Context, _ any) error {
			called = true
			return nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	svc.Delete(context.Background(), "id-1") //nolint:errcheck

	if !called {
		t.Error("Delete should delegate to repo.Delete")
	}
}

// ── Restore ───────────────────────────────────────────────────────────────────

func TestService_Restore_ErrorWhenNoSoftDelete(t *testing.T) {
	repo := &mockRepo{}
	svc := crud.NewServiceFromRepo(repo, hardMeta())

	_, err := svc.Restore(context.Background(), 1)
	if err == nil {
		t.Error("Restore should return an error when the table has no soft-delete field")
	}
}

func TestService_Restore_DelegatesToRepoWhenSoftDelete(t *testing.T) {
	called := false
	repo := &mockRepo{
		restore: func(_ context.Context, _ any) (map[string]any, error) {
			called = true
			return map[string]any{}, nil
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	_, err := svc.Restore(context.Background(), "id-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("Restore should delegate to repo.Restore")
	}
}

// ── ErrNotFound ───────────────────────────────────────────────────────────────

func TestService_GetByID_PropagatesErrNotFound(t *testing.T) {
	repo := &mockRepo{
		findByID: func(_ context.Context, _ any) (map[string]any, error) {
			return nil, crud.ErrNotFound
		},
	}
	svc := crud.NewServiceFromRepo(repo, softMeta())
	_, err := svc.GetByID(context.Background(), "missing")
	if !errors.Is(err, crud.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}
