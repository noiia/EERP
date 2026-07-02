package crud_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"core/orm/access"
	"core/orm/internal/crud"
	"core/orm/internal/registry"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── fixtures ────────────────────────────────────────────────────────────────

// tenantItem carries a tenant_id column, so the repository must isolate it.
type tenantItem struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Label    string    `db:"label"`
}

// globalItem has no tenant_id, so it stays global (no scoping applied).
type globalItem struct {
	model.BaseModel
	Label string `db:"label"`
}

func tenantMeta(t *testing.T) registry.TableMeta {
	t.Helper()
	if err := registry.Register[tenantItem](); err != nil {
		t.Fatalf("register tenantItem: %v", err)
	}
	m, ok := registry.Get("tenant_item")
	if !ok {
		t.Fatal("tenant_item not registered")
	}
	return m
}

func globalMeta(t *testing.T) registry.TableMeta {
	t.Helper()
	if err := registry.Register[globalItem](); err != nil {
		t.Fatalf("register globalItem: %v", err)
	}
	m, ok := registry.Get("global_item")
	if !ok {
		t.Fatal("global_item not registered")
	}
	return m
}

// ── fake executor ──────────────────────────────────────────────────────────

// captureExec records every statement it is asked to run so tests can assert on
// the generated SQL and args. It returns empty result sets.
type captureExec struct {
	queries []string
	args    [][]any
}

func (e *captureExec) record(sql string, args []any) {
	e.queries = append(e.queries, sql)
	e.args = append(e.args, args)
}

func (e *captureExec) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	e.record(sql, args)
	return emptyRows{}, nil
}

func (e *captureExec) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	e.record(sql, args)
	return zeroRow{}
}

func (e *captureExec) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	e.record(sql, args)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

// last returns the SQL/args of the statement whose SQL contains sub.
func (e *captureExec) find(t *testing.T, sub string) (string, []any) {
	t.Helper()
	for i, q := range e.queries {
		if strings.Contains(q, sub) {
			return q, e.args[i]
		}
	}
	t.Fatalf("no captured query contains %q; captured=%v", sub, e.queries)
	return "", nil
}

type emptyRows struct{}

func (emptyRows) Close()                                       {}
func (emptyRows) Err() error                                   { return nil }
func (emptyRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (emptyRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (emptyRows) Next() bool                                   { return false }
func (emptyRows) Scan(_ ...any) error                          { return nil }
func (emptyRows) Values() ([]any, error)                       { return nil, nil }
func (emptyRows) RawValues() [][]byte                          { return nil }
func (emptyRows) Conn() *pgx.Conn                              { return nil }

type zeroRow struct{}

func (zeroRow) Scan(dest ...any) error {
	if len(dest) == 1 {
		if p, ok := dest[0].(*int64); ok {
			*p = 0
		}
	}
	return nil
}

// argsContain reports whether target is among args.
func argsContain(args []any, target uuid.UUID) bool {
	for _, a := range args {
		if id, ok := a.(uuid.UUID); ok && id == target {
			return true
		}
	}
	return false
}

// ── tests ──────────────────────────────────────────────────────────────────

func TestRepository_FindAll_ScopesEveryStatementToTenant(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, tenantMeta(t))
	tid := uuid.New()
	ctx := access.WithTenant(context.Background(), tid)

	if _, _, err := repo.FindAll(ctx, 1, 20); err != nil {
		t.Fatalf("FindAll: %v", err)
	}

	if len(ex.queries) < 2 {
		t.Fatalf("expected a count and a select query, got %v", ex.queries)
	}
	for _, q := range ex.queries { // count + paginated select must both be scoped
		if !strings.Contains(q, "tenant_id =") {
			t.Errorf("query not tenant-scoped: %q", q)
		}
	}
	_, args := ex.find(t, "tenant_id =")
	if !argsContain(args, tid) {
		t.Errorf("tenant id %v not bound as an argument: %v", tid, args)
	}
}

func TestRepository_FindByID_ScopesToTenant(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, tenantMeta(t))
	ctx := access.WithTenant(context.Background(), uuid.New())

	_, _ = repo.FindByID(ctx, uuid.New())

	q, _ := ex.find(t, "SELECT")
	if !strings.Contains(q, "tenant_id =") {
		t.Errorf("FindByID not tenant-scoped: %q", q)
	}
}

func TestRepository_Create_ForcesCallerTenant(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, tenantMeta(t))
	caller := uuid.New()
	other := uuid.New()
	ctx := access.WithTenant(context.Background(), caller)

	// Client tries to plant a row in another tenant. The stub returns no rows so
	// the RETURNING scan errors, but the statement is captured before that — we
	// assert on the generated SQL/args, not the (stubbed) result.
	_, _ = repo.Create(ctx, map[string]any{"label": "x", "tenant_id": other})

	q, args := ex.find(t, "INSERT INTO tenant_item")
	if !strings.Contains(q, "tenant_id") {
		t.Errorf("INSERT missing tenant_id column: %q", q)
	}
	if !argsContain(args, caller) {
		t.Errorf("caller tenant %v not forced into INSERT args: %v", caller, args)
	}
	if argsContain(args, other) {
		t.Errorf("client-supplied tenant %v must not survive: %v", other, args)
	}
}

func TestRepository_Update_StripsTenantFromSetAndScopesWhere(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, tenantMeta(t))
	caller := uuid.New()
	other := uuid.New()
	ctx := access.WithTenant(context.Background(), caller)

	_, _ = repo.Update(ctx, uuid.New(), map[string]any{"label": "x", "tenant_id": other})

	q, _ := ex.find(t, "UPDATE tenant_item")
	setPart, wherePart, ok := strings.Cut(q, " WHERE ")
	if !ok {
		t.Fatalf("update has no WHERE: %q", q)
	}
	if strings.Contains(setPart, "tenant_id") {
		t.Errorf("tenant_id must not be settable on update: %q", setPart)
	}
	if !strings.Contains(wherePart, "tenant_id =") {
		t.Errorf("update WHERE not tenant-scoped: %q", wherePart)
	}
}

func TestRepository_Delete_ScopesToTenant(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, tenantMeta(t)) // soft-delete table → UPDATE
	ctx := access.WithTenant(context.Background(), uuid.New())

	_ = repo.Delete(ctx, uuid.New())

	q, _ := ex.find(t, "UPDATE tenant_item")
	if !strings.Contains(q, "tenant_id =") {
		t.Errorf("delete not tenant-scoped: %q", q)
	}
}

func TestRepository_FailsClosedWithoutTenant(t *testing.T) {
	repo := crud.NewRepository(&captureExec{}, tenantMeta(t))
	ctx := context.Background() // no tenant stamped

	if _, _, err := repo.FindAll(ctx, 1, 20); !errors.Is(err, crud.ErrTenantMissing) {
		t.Errorf("FindAll: want ErrTenantMissing, got %v", err)
	}
	if _, err := repo.FindByID(ctx, uuid.New()); !errors.Is(err, crud.ErrTenantMissing) {
		t.Errorf("FindByID: want ErrTenantMissing, got %v", err)
	}
	if _, err := repo.Create(ctx, map[string]any{"label": "x"}); !errors.Is(err, crud.ErrTenantMissing) {
		t.Errorf("Create: want ErrTenantMissing, got %v", err)
	}
	if _, err := repo.Update(ctx, uuid.New(), map[string]any{"label": "x"}); !errors.Is(err, crud.ErrTenantMissing) {
		t.Errorf("Update: want ErrTenantMissing, got %v", err)
	}
	if err := repo.Delete(ctx, uuid.New()); !errors.Is(err, crud.ErrTenantMissing) {
		t.Errorf("Delete: want ErrTenantMissing, got %v", err)
	}
}

func TestRepository_GlobalTable_NotScopedAndWorksWithoutTenant(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, globalMeta(t))
	ctx := context.Background() // no tenant — fine for a global table

	if _, _, err := repo.FindAll(ctx, 1, 20); err != nil {
		t.Fatalf("FindAll on global table: %v", err)
	}
	for _, q := range ex.queries {
		if strings.Contains(q, "tenant_id") {
			t.Errorf("global table must not be tenant-scoped: %q", q)
		}
	}
}
