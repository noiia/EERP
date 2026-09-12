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

// gatedItem carries one field gated to a group, for the filter/search
// group-gating tests (ADR-013's documented follow-up).
type gatedItem struct {
	model.BaseModel
	Label  string `db:"label"`
	Secret string `db:"secret"`
}

// rangeItem carries a numeric and a time column, for the range-filter cast tests.
type rangeItem struct {
	model.BaseModel
	Label string  `db:"label"`
	Price float64 `db:"price"`
}

func rangeMeta(t *testing.T) registry.TableMeta {
	t.Helper()
	if err := registry.Register[rangeItem](); err != nil {
		t.Fatalf("register rangeItem: %v", err)
	}
	m, ok := registry.Get("range_item")
	if !ok {
		t.Fatal("range_item not registered")
	}
	return m
}

func gatedMeta(t *testing.T) registry.TableMeta {
	t.Helper()
	if err := registry.Register[gatedItem](
		registry.WithFieldGroups(map[string][]string{"secret": {"hr_manager"}}),
	); err != nil {
		t.Fatalf("register gatedItem: %v", err)
	}
	m, ok := registry.Get("gated_item")
	if !ok {
		t.Fatal("gated_item not registered")
	}
	return m
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

	if _, _, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20}); err != nil {
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

	if _, _, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20}); !errors.Is(err, crud.ErrTenantMissing) {
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

	if _, _, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20}); err != nil {
		t.Fatalf("FindAll on global table: %v", err)
	}
	for _, q := range ex.queries {
		if strings.Contains(q, "tenant_id") {
			t.Errorf("global table must not be tenant-scoped: %q", q)
		}
	}
}

func TestRepository_FindAll_AppliesEqualsAndMatchesFilters(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, globalMeta(t))
	target := uuid.New()

	_, _, err := repo.FindAll(context.Background(), crud.ListFilter{
		Page:     1,
		PageSize: 20,
		Equals:   map[string]string{"id": target.String()},
		Matches:  map[string]string{"label": "ada"},
	})
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}

	if len(ex.queries) < 2 {
		t.Fatalf("expected a count and a select query, got %v", ex.queries)
	}
	for _, q := range ex.queries { // count + paginated select must both filter
		if !strings.Contains(q, "id::text =") {
			t.Errorf("query missing the equals filter: %q", q)
		}
		if !strings.Contains(q, "label::text ILIKE") {
			t.Errorf("query missing the matches filter: %q", q)
		}
	}
	// Filter values are bound as parameters, never interpolated.
	sql, args := ex.find(t, "ILIKE")
	if strings.Contains(sql, "ada") || strings.Contains(sql, target.String()) {
		t.Errorf("filter value interpolated into SQL: %q", sql)
	}
	found := 0
	for _, a := range args {
		if a == "ada" || a == target.String() {
			found++
		}
	}
	if found != 2 {
		t.Errorf("filter values not bound as args: %v", args)
	}
}

func TestRepository_FindAll_RejectsUnknownFilterColumn(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, globalMeta(t))

	_, _, err := repo.FindAll(context.Background(), crud.ListFilter{
		Equals: map[string]string{"nope; DROP TABLE": "x"},
	})
	if !errors.Is(err, crud.ErrUnknownColumn) {
		t.Fatalf("err = %v, want ErrUnknownColumn", err)
	}
	if len(ex.queries) != 0 {
		t.Errorf("no SQL must run for an unknown column, got %v", ex.queries)
	}
}

// ── In / range filters ──────────────────────────────────────────────────

func TestRepository_FindAll_AppliesInFilter(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, rangeMeta(t))

	_, _, err := repo.FindAll(context.Background(), crud.ListFilter{
		In: map[string][]string{"label": {"open", "pending"}},
	})
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	for _, q := range ex.queries {
		if !strings.Contains(q, "label::text = ANY($1)") {
			t.Errorf("query missing the In filter: %q", q)
		}
	}
}

func TestRepository_FindAll_RangeFiltersUseTypeAwareCasts(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, rangeMeta(t))

	_, _, err := repo.FindAll(context.Background(), crud.ListFilter{
		GT:  map[string]string{"price": "10"},
		LTE: map[string]string{"created_at": "2026-01-01"},
	})
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	found := map[string]bool{}
	for _, q := range ex.queries {
		if strings.Contains(q, "price::numeric > $") {
			found["price"] = true
		}
		if strings.Contains(q, "created_at::timestamptz <= $") {
			found["created_at"] = true
		}
	}
	if !found["price"] {
		t.Errorf("expected a numeric-cast GT condition on price, got %v", ex.queries)
	}
	if !found["created_at"] {
		t.Errorf("expected a timestamptz-cast LTE condition on created_at, got %v", ex.queries)
	}
}

func TestRepository_FindAll_RejectsUnknownInAndRangeColumns(t *testing.T) {
	for _, f := range []crud.ListFilter{
		{In: map[string][]string{"nope": {"x"}}},
		{GT: map[string]string{"nope": "1"}},
	} {
		ex := &captureExec{}
		repo := crud.NewRepository(ex, rangeMeta(t))
		_, _, err := repo.FindAll(context.Background(), f)
		if !errors.Is(err, crud.ErrUnknownColumn) {
			t.Errorf("filter %+v: err = %v, want ErrUnknownColumn", f, err)
		}
	}
}

// ── DistinctValues (group-by) ──────────────────────────────────────────────

func TestRepository_DistinctValues_GroupsAndCounts(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, rangeMeta(t))

	_, err := repo.DistinctValues(context.Background(), "label", crud.ListFilter{})
	if err != nil {
		t.Fatalf("DistinctValues: %v", err)
	}
	q, _ := ex.find(t, "GROUP BY")
	if !strings.Contains(q, "label::text AS value") {
		t.Errorf("query missing the value projection: %q", q)
	}
	if !strings.Contains(q, "COUNT(*) AS total") {
		t.Errorf("query missing the count projection: %q", q)
	}
	if !strings.Contains(q, "GROUP BY label") {
		t.Errorf("query missing GROUP BY: %q", q)
	}
	if !strings.Contains(q, "LIMIT 500") {
		t.Errorf("query missing the distinct-values cap: %q", q)
	}
}

func TestRepository_DistinctValues_RespectsActiveFilters(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, rangeMeta(t))

	_, err := repo.DistinctValues(context.Background(), "label", crud.ListFilter{
		Matches: map[string]string{"label": "open"},
	})
	if err != nil {
		t.Fatalf("DistinctValues: %v", err)
	}
	q, _ := ex.find(t, "GROUP BY")
	if !strings.Contains(q, "label::text ILIKE") {
		t.Errorf("query missing the active search filter: %q", q)
	}
}

func TestRepository_DistinctValues_RejectsUnknownColumn(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, rangeMeta(t))

	_, err := repo.DistinctValues(context.Background(), "nope", crud.ListFilter{})
	if !errors.Is(err, crud.ErrUnknownColumn) {
		t.Fatalf("err = %v, want ErrUnknownColumn", err)
	}
	if len(ex.queries) != 0 {
		t.Errorf("no SQL must run for an unknown column, got %v", ex.queries)
	}
}

func TestRepository_DistinctValues_RejectsGatedColumnWithoutGroup(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, gatedMeta(t))

	_, err := repo.DistinctValues(context.Background(), "secret", crud.ListFilter{})
	if !errors.Is(err, crud.ErrUnknownColumn) {
		t.Fatalf("err = %v, want ErrUnknownColumn — group-by must be group-gated too", err)
	}
}

// ── ADR-013 follow-up: filter/search must be group-aware ──────────────────

func TestRepository_FindAll_RejectsGatedFilterColumnWithoutGroup(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, gatedMeta(t))

	// No groups on the context at all — the fail-open default everywhere
	// else in this system means "no groups", not "every group".
	_, _, err := repo.FindAll(context.Background(), crud.ListFilter{
		Equals: map[string]string{"secret": "x"},
	})
	if !errors.Is(err, crud.ErrUnknownColumn) {
		t.Fatalf("err = %v, want ErrUnknownColumn", err)
	}
	if len(ex.queries) != 0 {
		t.Errorf("no SQL must run for a gated column the caller lacks, got %v", ex.queries)
	}
}

func TestRepository_FindAll_RejectsGatedSearchColumnForWrongGroup(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, gatedMeta(t))
	ctx := access.WithGroups(context.Background(), []string{"some_other_group"})

	_, _, err := repo.FindAll(ctx, crud.ListFilter{
		Matches: map[string]string{"secret": "x"},
	})
	if !errors.Is(err, crud.ErrUnknownColumn) {
		t.Fatalf("err = %v, want ErrUnknownColumn", err)
	}
}

func TestRepository_FindAll_AllowsGatedFilterColumnWithMatchingGroup(t *testing.T) {
	ex := &captureExec{}
	repo := crud.NewRepository(ex, gatedMeta(t))
	ctx := access.WithGroups(context.Background(), []string{"hr_manager"})

	_, _, err := repo.FindAll(ctx, crud.ListFilter{
		Equals: map[string]string{"secret": "x"},
	})
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	for _, q := range ex.queries {
		if !strings.Contains(q, "secret::text =") {
			t.Errorf("query missing the gated filter once the caller has the group: %q", q)
		}
	}
}

func TestRepository_FindAll_UngatedColumnUnaffectedByAbsentGroups(t *testing.T) {
	// A table with no gated fields must keep working exactly as before —
	// zero behavior change for every caller/table not using WithFieldGroups.
	ex := &captureExec{}
	repo := crud.NewRepository(ex, gatedMeta(t))

	_, _, err := repo.FindAll(context.Background(), crud.ListFilter{
		Equals: map[string]string{"label": "x"},
	})
	if err != nil {
		t.Fatalf("FindAll on ungated column with no groups on context: %v", err)
	}
}
