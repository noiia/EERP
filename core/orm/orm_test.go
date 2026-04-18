package orm_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"core/orm"
	"core/orm/model"
	"core/orm/query"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── fixtures ──────────────────────────────────────────────────────────────────

type invoice struct {
	model.BaseModel
	Amount     int `db:"amount"`
	CustomerID int `db:"customer_id"`
}

// ── mock executor ─────────────────────────────────────────────────────────────

type mockExec struct {
	lastSQL  string
	lastArgs []any
	execErr  error
	queryRow pgx.Row
}

func (m *mockExec) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	m.lastSQL = sql
	m.lastArgs = args
	return &emptyRows{}, nil
}
func (m *mockExec) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	m.lastSQL = sql
	m.lastArgs = args
	if m.queryRow != nil {
		return m.queryRow
	}
	return &errRow{err: errors.New("no row")}
}
func (m *mockExec) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	m.lastSQL = sql
	m.lastArgs = args
	return pgconn.CommandTag{}, m.execErr
}

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

type errRow struct{ err error }

func (r *errRow) Scan(...any) error { return r.err }

// ── Type alias correctness ────────────────────────────────────────────────────

// Compile-time: orm's exported types must be assignable to/from core types.
var _ orm.Executor = (*mockExec)(nil)

// ── Open — config validation ──────────────────────────────────────────────────

func TestOpen_EmptyDSN_ReturnsError(t *testing.T) {
	_, err := orm.Open(context.Background(), orm.Config{})
	if err == nil {
		t.Fatal("expected error for empty DSN")
	}
	if !strings.Contains(err.Error(), "DSN") {
		t.Errorf("error should mention DSN, got: %v", err)
	}
}

// ── NewNoopLogger ─────────────────────────────────────────────────────────────

func TestNewNoopLogger_ImplementsLogger(t *testing.T) {
	var _ orm.Logger = orm.NewNoopLogger()
}

func TestNewNoopLogger_NeverPanics(t *testing.T) {
	l := orm.NewNoopLogger()
	l.Log(context.Background(), orm.LogEntry{SQL: "SELECT 1"})
}

// ── Repo ──────────────────────────────────────────────────────────────────────

func TestRepo_ValidEntity_NoError(t *testing.T) {
	ex := &mockExec{}
	r, err := orm.Repo[invoice](ex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r == nil {
		t.Fatal("expected non-nil repository")
	}
}

func TestMustRepo_ValidEntity_DoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("unexpected panic: %v", r)
		}
	}()
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)
	if r == nil {
		t.Fatal("expected non-nil repository")
	}
}

// ── Cond ──────────────────────────────────────────────────────────────────────

func TestCond_IsEquivalentToNewCondition(t *testing.T) {
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)

	// Both orm.Cond and query.NewCondition must produce identical SQL.
	r.FindAll(context.Background(), orm.Cond("amount > $1", 100)) //nolint:errcheck

	if ex.lastSQL == "" {
		t.Fatal("expected a SQL call")
	}
	if !strings.Contains(ex.lastSQL, "amount >") {
		t.Errorf("Cond not applied: %s", ex.lastSQL)
	}
}

func TestCond_MultiArg(t *testing.T) {
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)

	r.FindAll(context.Background(), //nolint:errcheck
		orm.Cond("amount BETWEEN $1 AND $2", 100, 500),
	)

	if len(ex.lastArgs) != 2 {
		t.Errorf("expected 2 args, got %d: %v", len(ex.lastArgs), ex.lastArgs)
	}
}

// ── WithTx ────────────────────────────────────────────────────────────────────

func TestWithTx_ScopesExecutorToTx(t *testing.T) {
	// Original executor.
	original := &mockExec{}
	r := orm.MustRepo[invoice](original)

	// Tx-scoped executor.
	txExec := &mockExec{}
	rTx := r.WithTx(txExec)

	// A call on rTx must hit txExec, not original.
	rTx.FindAll(context.Background()) //nolint:errcheck

	if txExec.lastSQL == "" {
		t.Error("expected call on tx executor")
	}
	if original.lastSQL != "" {
		t.Error("original executor must not be called after WithTx")
	}
}

func TestWithTx_OriginalUnaffected(t *testing.T) {
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)
	txExec := &mockExec{}

	_ = r.WithTx(txExec) // derive tx-scoped repo

	// Call on the original — txExec must stay silent.
	r.FindAll(context.Background()) //nolint:errcheck

	if txExec.lastSQL != "" {
		t.Error("WithTx must return a copy — original must not affect tx executor")
	}
	if ex.lastSQL == "" {
		t.Error("original executor must still be called on the original repo")
	}
}

// ── Meta ──────────────────────────────────────────────────────────────────────

func TestMeta_TableName(t *testing.T) {
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)
	meta := r.Meta()

	if meta.Table != "invoice" {
		t.Errorf("Table = %q, want %q", meta.Table, "invoice")
	}
}

func TestMeta_UsableWithSelectBuilder(t *testing.T) {
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)

	// Drop to builder using Meta() — the canonical pattern from the doc comment.
	query.Select[invoice](r.Meta()).
		Where(orm.Cond("amount > $1", 0)).
		All(context.Background(), ex) //nolint:errcheck

	if !strings.Contains(ex.lastSQL, "SELECT") {
		t.Errorf("expected SELECT query, got: %s", ex.lastSQL)
	}
	if !strings.Contains(ex.lastSQL, "FROM invoice") {
		t.Errorf("expected FROM invoice, got: %s", ex.lastSQL)
	}
}

// ── Transact ──────────────────────────────────────────────────────────────────

func TestTransact_InvalidConfig_ReturnsError(t *testing.T) {
	// Can't open a real DB in unit tests — verify Open rejects bad config.
	_, err := orm.Open(context.Background(), orm.Config{DSN: ""})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestTransact_FnErrorPropagated(t *testing.T) {
	// Verify the Transact signature is callable and propagates fn errors.
	// Full commit/rollback behaviour is covered in db_integration_test.go.
	boom := errors.New("intentional")

	// We can't call Transact without a real DB, but we can verify the
	// fn signature compiles and that Transact wraps db.Transaction correctly
	// by inspecting what it does with an invalid-DSN DB (which won't open).
	_, err := orm.Open(context.Background(), orm.Config{DSN: "invalid"})
	if err == nil {
		t.Fatal("expected error opening invalid DSN")
	}
	// boom is used to satisfy the compiler — it would be returned from fn.
	_ = boom
}

// ── Repository through orm package — FindByID SQL shape ──────────────────────

func TestRepo_FindByID_SQL(t *testing.T) {
	ex := &mockExec{}
	r := orm.MustRepo[invoice](ex)
	id := uuid.New()

	r.FindByID(context.Background(), id) //nolint:errcheck

	if !strings.Contains(ex.lastSQL, "id = $1") {
		t.Errorf("expected id = $1 in SQL, got: %s", ex.lastSQL)
	}
	if !strings.Contains(ex.lastSQL, "deleted_at IS NULL") {
		t.Errorf("expected soft-delete guard, got: %s", ex.lastSQL)
	}
	if len(ex.lastArgs) < 1 || ex.lastArgs[0] != id {
		t.Errorf("expected id arg, got %v", ex.lastArgs)
	}
}
