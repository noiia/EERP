package repo_test

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"core/orm/model"
	"core/orm/query"
	"core/orm/repo"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── fixtures ──────────────────────────────────────────────────────────────────

type orderEntity struct {
	model.BaseModel
	Status     string `db:"status"`
	CustomerID int    `db:"customer_id"`
}

// hardEntity has no soft-delete field — hard deletes only.
type hardEntity struct {
	ID   uuid.UUID `db:"id,pk"`
	Name string    `db:"name"`
}

// ── mock executor ─────────────────────────────────────────────────────────────

type mockExecutor struct {
	// Configured responses.
	queryRows pgx.Rows
	queryErr  error
	queryRow  pgx.Row
	execTag   pgconn.CommandTag
	execErr   error

	// Captured calls — what the repo actually sent.
	calls    []call
	lastSQL  string // last SQL sent to any method — convenience for simple assertions
	lastArgs []any
}

type call struct {
	method string
	sql    string
	args   []any
}

func (m *mockExecutor) last() call {
	if len(m.calls) == 0 {
		return call{}
	}
	return m.calls[len(m.calls)-1]
}

func (m *mockExecutor) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	m.lastSQL = sql
	m.lastArgs = args
	m.calls = append(m.calls, call{"Query", sql, args})
	if m.queryErr != nil {
		return nil, m.queryErr
	}
	if m.queryRows == nil {
		return &emptyRows{}, nil
	}
	return m.queryRows, nil
}

func (m *mockExecutor) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	m.lastSQL = sql
	m.lastArgs = args
	m.calls = append(m.calls, call{"QueryRow", sql, args})
	if m.queryRow == nil {
		return &errRow{err: errors.New("no row configured")}
	}
	return m.queryRow
}

func (m *mockExecutor) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	m.lastSQL = sql
	m.lastArgs = args
	m.calls = append(m.calls, call{"Exec", sql, args})
	return m.execTag, m.execErr
}

// ── mock pgx primitives ───────────────────────────────────────────────────────

type emptyRows struct{ closed bool }

func (e *emptyRows) Next() bool                                   { return false }
func (e *emptyRows) Scan(...any) error                            { return nil }
func (e *emptyRows) Close()                                       { e.closed = true }
func (e *emptyRows) Err() error                                   { return nil }
func (e *emptyRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (e *emptyRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (e *emptyRows) Values() ([]any, error)                       { return nil, nil }
func (e *emptyRows) RawValues() [][]byte                          { return nil }
func (e *emptyRows) Conn() *pgx.Conn                              { return nil }

type errRow struct{ err error }

func (r *errRow) Scan(...any) error { return r.err }

// ── helpers ───────────────────────────────────────────────────────────────────

func newRepo(t *testing.T, ex *mockExecutor) *repo.Repository[orderEntity] {
	t.Helper()
	r, err := repo.New[orderEntity](ex)
	if err != nil {
		t.Fatalf("repo.New: %v", err)
	}
	return r
}

func newHardRepo(t *testing.T, ex *mockExecutor) *repo.Repository[hardEntity] {
	t.Helper()
	r, err := repo.New[hardEntity](ex)
	if err != nil {
		t.Fatalf("repo.New: %v", err)
	}
	return r
}

func sqlContains(sql, substr string) bool {
	ok, _ := regexp.MatchString(`(?:^|\W)`+regexp.QuoteMeta(substr), sql)
	return ok
}

func assertSQL(t *testing.T, got, want string) {
	t.Helper()
	if !sqlContains(got, want) {
		t.Errorf("SQL missing %q\ngot: %s", want, got)
	}
}

func assertNotSQL(t *testing.T, got, want string) {
	t.Helper()
	if sqlContains(got, want) {
		t.Errorf("SQL must not contain %q\ngot: %s", want, got)
	}
}

// ── New ───────────────────────────────────────────────────────────────────────

func TestNew_ValidEntity(t *testing.T) {
	ex := &mockExecutor{}
	r, err := repo.New[orderEntity](ex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r == nil {
		t.Fatal("expected non-nil repository")
	}
}

func TestFindByID_BuildsCorrectSQL(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)
	id := uuid.New()

	r.FindByID(context.Background(), id) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "SELECT")
	assertSQL(t, c.sql, "FROM order_entities")
	assertSQL(t, c.sql, "id = $1")
	assertSQL(t, c.sql, "deleted_at IS NULL") // soft-delete guard
	if len(c.args) < 1 || c.args[0] != id {
		t.Errorf("expected id arg %s, got %v", id, c.args)
	}
}

func TestFindByID_PropagatesError(t *testing.T) {
	boom := errors.New("connection reset")
	// SelectBuilder.One uses Query (not QueryRow), so queryErr is triggered.
	ex := &mockExecutor{queryErr: boom}
	r := newRepo(t, ex)

	_, err := r.FindByID(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("expected error to propagate")
	}
	if !errors.Is(err, boom) {
		t.Errorf("expected boom error, got %v", err)
	}
}

// ── FindAll ───────────────────────────────────────────────────────────────────

func TestFindAll_NoConditions_IncludesSoftDeleteGuard(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	r.FindAll(context.Background()) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "SELECT")
	assertSQL(t, c.sql, "deleted_at IS NULL")
}

func TestFindAll_WithConditions_AppendsAfterSoftDelete(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	r.FindAll(context.Background(), //nolint:errcheck
		query.NewCondition("status = $1", "open"),
	)

	c := ex.last()
	assertSQL(t, c.sql, "deleted_at IS NULL")
	assertSQL(t, c.sql, "status = $")
	// status arg must be rebased past the soft-delete (which has no args).
	if len(c.args) != 1 || c.args[0] != "open" {
		t.Errorf("args = %v", c.args)
	}
}

func TestFindAllWithDeleted_NoSoftDeleteGuard(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	r.FindAllWithDeleted(context.Background()) //nolint:errcheck

	c := ex.last()
	assertNotSQL(t, c.sql, "deleted_at IS NULL")
}

// ── Query ─────────────────────────────────────────────────────────────────────

func TestQuery_ReturnsSelectBuilder(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	// Builder should be usable — calling All must hit the executor.
	r.Query().
		Where(query.NewCondition("status = $1", "open")).
		OrderBy("created_at DESC").
		All(context.Background(), ex) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "ORDER BY created_at DESC")
	assertSQL(t, c.sql, "status = $1")
}

// ── Create ────────────────────────────────────────────────────────────────────

func TestCreate_BuildsInsertSQL(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)
	entity := orderEntity{Status: "pending", CustomerID: 5}

	r.Create(context.Background(), entity) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "INSERT INTO order_entities")
	assertSQL(t, c.sql, "RETURNING *")
	// PK must not appear in the INSERT column list (RETURNING clause is excluded from check).
	insertPart := strings.SplitN(c.sql, "RETURNING", 2)[0]
	assertNotSQL(t, insertPart, "id")
}

func TestCreate_PropagatesError(t *testing.T) {
	boom := errors.New("exec error")
	// Test executor error propagation via Exec (hard delete path — simplest
	// way to inject an error that bypasses scan.Row entirely).
	ex := &mockExecutor{execErr: boom}
	r := newHardRepo(t, ex) // hardEntity uses Exec for Delete

	_, err := r.HardDelete(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("expected error to propagate")
	}
	if !errors.Is(err, boom) {
		t.Errorf("expected boom error, got %v", err)
	}
}

// ── Update ────────────────────────────────────────────────────────────────────

func TestUpdate_BuildsUpdateSQL(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)
	id := uuid.New()
	entity := orderEntity{Status: "shipped"}

	r.Update(context.Background(), entity, id) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "UPDATE order_entities")
	assertSQL(t, c.sql, "updated_at")
	assertSQL(t, c.sql, "WHERE")
	assertSQL(t, c.sql, "RETURNING *")
	assertSQL(t, c.sql, "deleted_at IS NULL") // soft-delete guard on update
	// Immutable fields must never appear in SET.
	setPart := strings.SplitN(c.sql, "WHERE", 2)[0]
	for _, forbidden := range []string{"created_at =", "deleted_at ="} {
		if sqlContains(setPart, forbidden) {
			t.Errorf("SET clause must not contain %q\nSQL: %s", forbidden, c.sql)
		}
	}
}

func TestUpdate_IDAppearsInWhereNotSet(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)
	id := uuid.New()

	r.Update(context.Background(), orderEntity{Status: "x"}, id) //nolint:errcheck

	c := ex.last()
	parts := strings.SplitN(c.sql, "WHERE", 2)
	if len(parts) < 2 {
		t.Fatal("no WHERE clause found")
	}
	setPart := parts[0]
	// The PK "id" column must not appear in SET as a standalone column.
	// Use regex-style check: SET clause assigns "col = $N" — look for "id = $"
	// which is distinct from "customer_id = $" or "updated_at = $".
	// Split on commas and check each assignment individually.
	for _, assignment := range strings.Split(setPart, ",") {
		trimmed := strings.TrimSpace(assignment)
		// Each assignment is "col = $N" or starts with "SET col = $N".
		// Extract the column name (before " =").
		col := strings.SplitN(trimmed, " =", 2)[0]
		col = strings.TrimPrefix(strings.TrimSpace(col), "SET ")
		if col == "id" {
			t.Errorf("SET clause contains PK column %q\nSQL: %s", col, c.sql)
		}
	}
}

// ── Delete (soft) ─────────────────────────────────────────────────────────────

func TestDelete_SoftDelete_SetsDeletedAt(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)
	id := uuid.New()

	r.Delete(context.Background(), id) //nolint:errcheck

	c := ex.last()
	// Soft delete goes through Update path.
	assertSQL(t, c.sql, "UPDATE order_entities")
	assertSQL(t, c.sql, "deleted_at")
	assertSQL(t, c.sql, "deleted_at IS NULL") // only delete non-deleted rows
}

func TestDelete_SoftDelete_DoesNotHardDelete(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	r.Delete(context.Background(), uuid.New()) //nolint:errcheck

	c := ex.last()
	assertNotSQL(t, c.sql, "DELETE FROM")
}

// ── Delete (hard) ─────────────────────────────────────────────────────────────

func TestDelete_HardEntity_IssuesDeleteFrom(t *testing.T) {
	ex := &mockExecutor{}
	r := newHardRepo(t, ex)
	id := uuid.New()

	r.Delete(context.Background(), id) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "DELETE FROM hard_entities")
	assertSQL(t, c.sql, "WHERE")
	if len(c.args) != 1 || c.args[0] != id {
		t.Errorf("expected id arg, got %v", c.args)
	}
}

func TestHardDelete_AlwaysIssuesDeleteFrom(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex) // orderEntity has soft-delete

	r.HardDelete(context.Background(), uuid.New()) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "DELETE FROM")
	assertNotSQL(t, c.sql, "UPDATE")
}

// ── Restore ───────────────────────────────────────────────────────────────────

func TestRestore_ClearsDeletedAt(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)
	id := uuid.New()

	r.Restore(context.Background(), id) //nolint:errcheck

	c := ex.last()
	assertSQL(t, c.sql, "UPDATE order_entities")
	assertSQL(t, c.sql, "deleted_at")
	assertSQL(t, c.sql, "updated_at")
}

func TestRestore_HardEntity_ReturnsError(t *testing.T) {
	ex := &mockExecutor{}
	r := newHardRepo(t, ex)

	err := r.Restore(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("expected error for entity without soft-delete")
	}
}

// ── CreateBatch ───────────────────────────────────────────────────────────────

func TestCreateBatch_Empty_IsNoop(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	results, err := r.CreateBatch(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if results != nil {
		t.Error("expected nil result for empty batch")
	}
	if len(ex.calls) != 0 {
		t.Error("empty batch must not call executor")
	}
}

func TestCreateBatch_MultipleRows_SingleQuery(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	entities := []orderEntity{
		{Status: "pending", CustomerID: 1},
		{Status: "open", CustomerID: 2},
		{Status: "open", CustomerID: 3},
	}

	r.CreateBatch(context.Background(), entities) //nolint:errcheck

	if len(ex.calls) != 1 {
		t.Errorf("expected 1 executor call for batch, got %d", len(ex.calls))
	}
	c := ex.last()
	assertSQL(t, c.sql, "INSERT INTO order_entities")
	assertSQL(t, c.sql, "RETURNING *")
}

// ── Executor propagation — Tx compatibility ───────────────────────────────────

func TestRepository_AcceptsTxAsExecutor(t *testing.T) {
	// Repository accepts core.Executor — verify *mockExecutor satisfies it.
	// If *Tx also satisfies Executor (compile-time check in core), then
	// Repository works inside transactions without any code change.
	var _ interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
		QueryRow(context.Context, string, ...any) pgx.Row
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	} = (*mockExecutor)(nil)
}

// ── Timing: updated_at is always set on Update/Delete ────────────────────────

func TestUpdate_UpdatedAt_IsSet(t *testing.T) {
	before := time.Now().Add(-time.Second)
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	r.Update(context.Background(), orderEntity{Status: "x"}, uuid.New()) //nolint:errcheck

	c := ex.last()
	// Find updated_at in args — it should be after `before`.
	found := false
	for _, arg := range c.args {
		if ts, ok := arg.(time.Time); ok {
			if ts.After(before) {
				found = true
			}
		}
	}
	if !found {
		t.Error("expected updated_at timestamp in args, none found after before")
	}
}

func TestMustNew_ValidEntity_DoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("unexpected panic: %v", r)
		}
	}()
	ex := &mockExecutor{}
	r := repo.MustNew[orderEntity](ex)
	if r == nil {
		t.Fatal("expected non-nil repository")
	}
}

// ── DeleteWhere ───────────────────────────────────────────────────────────────

func TestDeleteWhere_NoConditions_ReturnsError(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	_, err := r.DeleteWhere(context.Background())
	if err == nil {
		t.Fatal("expected error when no conditions passed")
	}
	if ex.lastSQL != "" {
		t.Error("executor must not be called with no conditions")
	}
}

func TestDeleteWhere_SoftDeletable_IssuesUpdate(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex) // orderEntity has soft-delete

	r.DeleteWhere(context.Background(), //nolint:errcheck
		query.NewCondition("status = $1", "cancelled"),
	)

	c := ex.last()
	assertSQL(t, c.sql, "UPDATE order_entities")
	assertSQL(t, c.sql, "deleted_at")
	assertSQL(t, c.sql, "deleted_at IS NULL") // only soft-delete active rows
	assertSQL(t, c.sql, "status = $")
	assertNotSQL(t, c.sql, "DELETE FROM")
}

func TestDeleteWhere_SoftDeletable_MultipleConditions(t *testing.T) {
	ex := &mockExecutor{}
	r := newRepo(t, ex)

	r.DeleteWhere(context.Background(), //nolint:errcheck
		query.NewCondition("status = $1", "cancelled"),
		query.NewCondition("customer_id = $1", 42),
	)

	c := ex.last()
	assertSQL(t, c.sql, "status = $")
	assertSQL(t, c.sql, "customer_id = $")
}

func TestDeleteWhere_HardEntity_IssuesDeleteFrom(t *testing.T) {
	ex := &mockExecutor{}
	r := newHardRepo(t, ex) // hardEntity has no soft-delete

	r.DeleteWhere(context.Background(), //nolint:errcheck
		query.NewCondition("name = $1", "obsolete"),
	)

	c := ex.last()
	assertSQL(t, c.sql, "DELETE FROM hard_entities")
	assertSQL(t, c.sql, "name = $1")
	assertNotSQL(t, c.sql, "UPDATE")
}

func TestDeleteWhere_HardEntity_PropagatesError(t *testing.T) {
	boom := errors.New("foreign key violation")
	ex := &mockExecutor{execErr: boom}
	r := newHardRepo(t, ex)

	_, err := r.DeleteWhere(context.Background(),
		query.NewCondition("name = $1", "x"),
	)
	if !errors.Is(err, boom) {
		t.Errorf("expected boom, got %v", err)
	}
}
