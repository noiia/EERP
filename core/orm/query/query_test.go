package query_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"core/orm/internal/cache"
	"core/orm/query"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── fixtures ──────────────────────────────────────────────────────────────────

type order struct {
	ID         int        `db:"id,pk"`
	CustomerID int        `db:"customer_id"`
	Status     string     `db:"status"`
	CreatedAt  time.Time  `db:"created_at"`
	DeletedAt  *time.Time `db:"deleted_at,softdelete"`
}

type lineItem struct {
	ID       int    `db:"id,pk"`
	OrderID  int    `db:"order_id"`
	Product  string `db:"product"`
	Quantity int    `db:"quantity"`
}

// ── mock executor ─────────────────────────────────────────────────────────────

type mockExecutor struct {
	rows     pgx.Rows
	row      pgx.Row
	execErr  error
	lastSQL  string
	lastArgs []any
}

func (m *mockExecutor) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	m.lastSQL = sql
	m.lastArgs = args
	if m.rows == nil {
		return &emptyRows{}, nil
	}
	return m.rows, nil
}

func (m *mockExecutor) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	m.lastSQL = sql
	m.lastArgs = args
	if m.row == nil {
		return &errRow{err: errors.New("no row")}
	}
	return m.row
}

func (m *mockExecutor) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	m.lastSQL = sql
	m.lastArgs = args
	return pgconn.CommandTag{}, m.execErr
}

// emptyRows satisfies pgx.Rows with zero data.
type emptyRows struct{}

func (e *emptyRows) Next() bool                                   { return false }
func (e *emptyRows) Scan(...any) error                            { return nil }
func (e *emptyRows) Close()                                       {}
func (e *emptyRows) Err() error                                   { return nil }
func (e *emptyRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (e *emptyRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (e *emptyRows) Values() ([]any, error)                       { return nil, nil }
func (e *emptyRows) RawValues() [][]byte                          { return nil }
func (e *emptyRows) Conn() *pgx.Conn                              { return nil }

// errRow satisfies pgx.Row returning a fixed error on Scan.
type errRow struct{ err error }

func (r *errRow) Scan(...any) error { return r.err }

// ── helpers ───────────────────────────────────────────────────────────────────

func mustMeta[T any](t *testing.T) cache.StructMeta {
	t.Helper()
	meta, err := cache.Get[T]()
	if err != nil {
		t.Fatalf("cache.Get: %v", err)
	}
	return meta
}

func assertContains(t *testing.T, sql, substr string) {
	t.Helper()
	if !strings.Contains(sql, " "+substr) && !strings.Contains(sql, substr) {
		t.Errorf("SQL missing %q\ngot: %s", substr, sql)
	}
}

func assertNotContains(t *testing.T, sql, substr string) {
	t.Helper()
	if strings.Contains(sql, " "+substr) && strings.Contains(sql, substr) {
		t.Errorf("SQL must not contain %q\ngot: %s", substr, sql)
	}
}

// ── Condition / whereClause ───────────────────────────────────────────────────

func TestCondition_Rebase_SingleArg(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args := query.Select[order](meta).
		Where(query.NewCondition("status = $1", "open")).
		ToSQL()

	assertContains(t, sql, "WHERE status = $1")
	if len(args) != 1 || args[0] != "open" {
		t.Errorf("args = %v", args)
	}
}

func TestCondition_Rebase_MultipleConditions(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args := query.Select[order](meta).
		Where(query.NewCondition("status = $1", "open")).
		Where(query.NewCondition("customer_id = $1", 42)).
		ToSQL()

	// Second condition must be rebased to $2.
	assertContains(t, sql, "status = $1")
	assertContains(t, sql, "customer_id = $2")
	if len(args) != 2 {
		t.Errorf("expected 2 args, got %d: %v", len(args), args)
	}
}

func TestCondition_Rebase_MultiArgCondition(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args := query.Select[order](meta).
		Where(query.NewCondition("created_at BETWEEN $1 AND $2", time.Now(), time.Now())).
		ToSQL()

	assertContains(t, sql, "$1")
	assertContains(t, sql, "$2")
	if len(args) != 2 {
		t.Errorf("expected 2 args, got %d", len(args))
	}
}

// ── SelectBuilder ─────────────────────────────────────────────────────────────

func TestSelect_ToSQL_AllColumns(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args := query.Select[order](meta).ToSQL()

	assertContains(t, sql, "SELECT")
	assertContains(t, sql, "FROM order")
	assertContains(t, sql, "id")
	assertContains(t, sql, "status")
	if len(args) != 0 {
		t.Errorf("no-where query must have no args, got %v", args)
	}
}

func TestSelect_ToSQL_ExplicitColumns(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).Columns("id", "status").ToSQL()

	assertContains(t, sql, "SELECT id, status")
	assertNotContains(t, sql, "customer_id")
}

func TestSelect_ToSQL_Where(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args := query.Select[order](meta).
		Where(query.NewCondition("status = $1", "open")).
		ToSQL()

	assertContains(t, sql, "WHERE status = $1")
	if len(args) != 1 {
		t.Errorf("expected 1 arg, got %d", len(args))
	}
}

func TestSelect_ToSQL_MultiWhere_AND(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).
		Where(query.NewCondition("status = $1", "open")).
		Where(query.NewCondition("customer_id = $1", 5)).
		ToSQL()

	assertContains(t, sql, "AND")
}

func TestSelect_ToSQL_Join(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).
		Join("JOIN order_lines ol ON ol.order_id = orders.id").
		ToSQL()

	assertContains(t, sql, "JOIN order_lines ol ON ol.order_id = orders.id")
}

func TestSelect_ToSQL_OrderBy(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).
		OrderBy("created_at DESC").
		ToSQL()

	assertContains(t, sql, "ORDER BY created_at DESC")
}

func TestSelect_ToSQL_MultiOrderBy(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).
		OrderBy("created_at DESC").
		OrderBy("id ASC").
		ToSQL()

	assertContains(t, sql, "ORDER BY created_at DESC, id ASC")
}

func TestSelect_ToSQL_Limit(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).Limit(10).ToSQL()
	assertContains(t, sql, "LIMIT 10")
}

func TestSelect_ToSQL_Offset(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).Offset(20).ToSQL()
	assertContains(t, sql, "OFFSET 20")
}

func TestSelect_ToSQL_NoLimit_NoOffset(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _ := query.Select[order](meta).ToSQL()
	assertNotContains(t, sql, "LIMIT")
	assertNotContains(t, sql, "OFFSET")
}

func TestSelect_Immutable_Branching(t *testing.T) {
	t.Parallel()

	// Mutating a derived builder must not affect the base builder.
	meta := mustMeta[order](t)
	base := query.Select[order](meta).Where(query.NewCondition("deleted_at IS NULL"))
	withLimit := base.Limit(5)

	basSQL, _ := base.ToSQL()
	limSQL, _ := withLimit.ToSQL()

	assertNotContains(t, basSQL, "LIMIT")
	assertContains(t, limSQL, "LIMIT 5")
}

func TestSelect_All_CallsQuery(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	query.Select[order](meta).All(context.Background(), ex) //nolint:errcheck

	if ex.lastSQL == "" {
		t.Error("expected Query to be called")
	}
	assertContains(t, ex.lastSQL, "SELECT")
	assertContains(t, ex.lastSQL, "FROM order")
}

func TestSelect_One_AddsLimit1(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	query.Select[order](meta).One(context.Background(), ex) //nolint:errcheck

	assertContains(t, ex.lastSQL, "LIMIT 1")
}

// ── InsertBuilder ─────────────────────────────────────────────────────────────

func TestInsert_ToSQL_SingleRow(t *testing.T) {
	t.Parallel()

	meta := mustMeta[lineItem](t)
	row := lineItem{OrderID: 1, Product: "widget", Quantity: 5}

	sql, args := query.Insert[lineItem](meta, row).ToSQL()

	assertContains(t, sql, "INSERT INTO line_item")
	assertContains(t, sql, "order_id")
	assertContains(t, sql, "product")
	assertContains(t, sql, "quantity")
	assertNotContains(t, sql, "id") // PK excluded from writable cols
	if len(args) != 3 {
		t.Errorf("expected 3 args (writable cols), got %d: %v", len(args), args)
	}
}

func TestInsert_ToSQL_Returning(t *testing.T) {
	t.Parallel()

	meta := mustMeta[lineItem](t)
	row := lineItem{OrderID: 1, Product: "widget", Quantity: 5}

	sql, _ := query.Insert[lineItem](meta, row).Returning("id", "order_id").ToSQL()

	assertContains(t, sql, "RETURNING id, order_id")
}

func TestInsert_ToSQL_BatchMultipleRows(t *testing.T) {
	t.Parallel()

	meta := mustMeta[lineItem](t)
	rows := []lineItem{
		{OrderID: 1, Product: "a", Quantity: 1},
		{OrderID: 1, Product: "b", Quantity: 2},
		{OrderID: 1, Product: "c", Quantity: 3},
	}

	sql, args := query.Insert[lineItem](meta, rows...).ToSQL()

	// Three value sets in the SQL.
	count := strings.Count(sql, "), (")
	if count != 2 { // 3 rows = 2 separators
		t.Errorf("expected 2 value set separators for 3 rows, got %d\nSQL: %s", count, sql)
	}
	// 3 rows × 3 writable cols = 9 args.
	if len(args) != 9 {
		t.Errorf("expected 9 args for 3 rows, got %d", len(args))
	}
}

func TestInsert_ToSQL_Placeholders_Sequential(t *testing.T) {
	t.Parallel()

	meta := mustMeta[lineItem](t)
	rows := []lineItem{
		{OrderID: 1, Product: "a", Quantity: 1},
		{OrderID: 2, Product: "b", Quantity: 2},
	}
	sql, _ := query.Insert[lineItem](meta, rows...).ToSQL()

	// $1..$3 for first row, $4..$6 for second row — no gaps, no repeats.
	for _, ph := range []string{"$1", "$2", "$3", "$4", "$5", "$6"} {
		assertContains(t, sql, ph)
	}
	assertNotContains(t, sql, "$7")
}

func TestInsert_Exec_CallsExec(t *testing.T) {
	t.Parallel()

	meta := mustMeta[lineItem](t)
	ex := &mockExecutor{}
	row := lineItem{OrderID: 1, Product: "x", Quantity: 1}

	err := query.Insert[lineItem](meta, row).Exec(context.Background(), ex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, ex.lastSQL, "INSERT INTO")
}

func TestInsert_NoRows_ExecIsNoop(t *testing.T) {
	t.Parallel()

	meta := mustMeta[lineItem](t)
	ex := &mockExecutor{}

	err := query.Insert[lineItem](meta).Exec(context.Background(), ex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ex.lastSQL != "" {
		t.Error("Exec with no rows should not call the executor")
	}
}

// ── UpdateBuilder ─────────────────────────────────────────────────────────────

func TestUpdate_ToSQL_Basic(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args, err := query.Update[order](meta).
		Set("status", "shipped").
		Where(query.NewCondition("id = $1", 99)).
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "UPDATE order")
	assertContains(t, sql, "SET status = $1")
	assertContains(t, sql, "WHERE id = $2")
	if len(args) != 2 || args[0] != "shipped" || args[1] != 99 {
		t.Errorf("args = %v", args)
	}
}

func TestUpdate_ToSQL_MultipleSet(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args, err := query.Update[order](meta).
		Set("status", "shipped").
		Set("customer_id", 7).
		Where(query.NewCondition("id = $1", 1)).
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "status = $1")
	assertContains(t, sql, "customer_id = $2")
	assertContains(t, sql, "WHERE id = $3")
	if len(args) != 3 {
		t.Errorf("expected 3 args, got %d: %v", len(args), args)
	}
}

func TestUpdate_ToSQL_Returning(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _, err := query.Update[order](meta).
		Set("status", "shipped").
		Where(query.NewCondition("id = $1", 1)).
		Returning("id", "status").
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "RETURNING id, status")
}

func TestUpdate_ToSQL_NoWhere_ReturnsError(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	_, _, err := query.Update[order](meta).
		Set("status", "shipped").
		ToSQL()

	if err == nil {
		t.Fatal("expected error for UPDATE without WHERE")
	}
	if !strings.Contains(err.Error(), "WHERE") {
		t.Errorf("error should mention WHERE, got: %v", err)
	}
}

func TestUpdate_ToSQL_NoSet_ReturnsError(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	_, _, err := query.Update[order](meta).
		Where(query.NewCondition("id = $1", 1)).
		ToSQL()

	if err == nil {
		t.Fatal("expected error for UPDATE without SET")
	}
}

func TestUpdate_FromStruct_SkipsPK(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	o := order{ID: 99, CustomerID: 5, Status: "open"}

	sql, _, err := query.Update[order](meta).
		FromStruct(o).
		Where(query.NewCondition("id = $1", 99)).
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// PK must appear in WHERE but not SET.
	parts := strings.SplitN(sql, "WHERE", 2)
	if strings.Contains(parts[0], " id =") {
		t.Error("SET clause must not contain the PK column")
	}
}

func TestUpdate_Immutable_Branching(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	base := query.Update[order](meta).
		Set("status", "open").
		Where(query.NewCondition("id = $1", 1))

	shipped := base.Set("status", "shipped")

	_, baseArgs, _ := base.ToSQL()
	_, shippedArgs, _ := shipped.ToSQL()

	// base has 2 args (1 set + 1 where), shipped has 3 (2 sets + 1 where).
	if len(baseArgs) != 2 {
		t.Errorf("base args = %d, want 2", len(baseArgs))
	}
	if len(shippedArgs) != 3 {
		t.Errorf("shipped args = %d, want 3", len(shippedArgs))
	}
}

func TestUpdate_Exec_CallsExec(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	_, err := query.Update[order](meta).
		Set("status", "shipped").
		Where(query.NewCondition("id = $1", 1)).
		Exec(context.Background(), ex)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, ex.lastSQL, "UPDATE order")
}

// ── DeleteBuilder ─────────────────────────────────────────────────────────────

func TestDelete_ToSQL_Basic(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args, err := query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 99)).
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "DELETE FROM order")
	assertContains(t, sql, "WHERE id = $1")
	if len(args) != 1 || args[0] != 99 {
		t.Errorf("args = %v, want [99]", args)
	}
}

func TestDelete_ToSQL_MultipleConditions(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args, err := query.Delete[order](meta).
		Where(query.NewCondition("status = $1", "cancelled")).
		Where(query.NewCondition("customer_id = $1", 5)).
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "status = $1")
	assertContains(t, sql, "customer_id = $2") // rebased correctly
	assertContains(t, sql, "AND")
	if len(args) != 2 {
		t.Errorf("expected 2 args, got %d: %v", len(args), args)
	}
}

func TestDelete_ToSQL_Returning(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _, err := query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 1)).
		Returning("id", "customer_id").
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "RETURNING id, customer_id")
}

func TestDelete_ToSQL_ReturningAll(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _, err := query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 1)).
		Returning("*").
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "RETURNING *")
}

func TestDelete_ToSQL_NoWhere_ReturnsError(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	_, _, err := query.Delete[order](meta).ToSQL()

	if err == nil {
		t.Fatal("expected error for DELETE without WHERE")
	}
	if !strings.Contains(err.Error(), "WHERE") {
		t.Errorf("error should mention WHERE, got: %v", err)
	}
}

func TestDelete_ToSQL_ErrorMentionsTable(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	_, _, err := query.Delete[order](meta).ToSQL()

	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "order") {
		t.Errorf("error should mention table name, got: %v", err)
	}
}

func TestDelete_Immutable_Branching(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	base := query.Delete[order](meta).
		Where(query.NewCondition("status = $1", "cancelled"))

	withExtra := base.Where(query.NewCondition("customer_id = $1", 7))

	_, baseArgs, _ := base.ToSQL()
	_, extraArgs, _ := withExtra.ToSQL()

	if len(baseArgs) != 1 {
		t.Errorf("base args = %d, want 1", len(baseArgs))
	}
	if len(extraArgs) != 2 {
		t.Errorf("extra args = %d, want 2", len(extraArgs))
	}
}

func TestDelete_Exec_CallsExec(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	n, err := query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 42)).
		Exec(context.Background(), ex)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 rows affected from mock, got %d", n)
	}
	assertContains(t, ex.lastSQL, "DELETE FROM order")
	assertContains(t, ex.lastSQL, "WHERE id = $1")
}

func TestDelete_Exec_PropagatesError(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	boom := errors.New("foreign key violation")
	ex := &mockExecutor{execErr: boom}

	_, err := query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 1)).
		Exec(context.Background(), ex)

	if !errors.Is(err, boom) {
		t.Errorf("expected boom, got %v", err)
	}
}

func TestDelete_Exec_NoWhere_DoesNotCallExecutor(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	query.Delete[order](meta).Exec(context.Background(), ex) //nolint:errcheck

	if ex.lastSQL != "" {
		t.Error("executor must not be called when ToSQL returns an error")
	}
}

func TestDelete_One_CallsQueryRow(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 1)).
		Returning("*").
		One(context.Background(), ex) //nolint:errcheck

	if ex.lastSQL == "" {
		t.Error("expected QueryRow to be called")
	}
	assertContains(t, ex.lastSQL, "DELETE FROM")
	assertContains(t, ex.lastSQL, "RETURNING *")
}

func TestDelete_All_CallsQuery(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	ex := &mockExecutor{}

	query.Delete[order](meta).
		Where(query.NewCondition("status = $1", "cancelled")).
		Returning("id").
		All(context.Background(), ex) //nolint:errcheck

	assertContains(t, ex.lastSQL, "DELETE FROM order")
	assertContains(t, ex.lastSQL, "RETURNING id")
}

func TestDelete_NoReturning_NoReturningClause(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, _, _ := query.Delete[order](meta).
		Where(query.NewCondition("id = $1", 1)).
		ToSQL()

	assertNotContains(t, sql, "RETURNING")
}

func TestDelete_PlaceholderRebasing_MultiArgCondition(t *testing.T) {
	t.Parallel()

	meta := mustMeta[order](t)
	sql, args, err := query.Delete[order](meta).
		Where(query.NewCondition("created_at BETWEEN $1 AND $2", time.Now(), time.Now())).
		ToSQL()

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "$1")
	assertContains(t, sql, "$2")
	assertNotContains(t, sql, "$3")
	if len(args) != 2 {
		t.Errorf("expected 2 args, got %d", len(args))
	}
}
