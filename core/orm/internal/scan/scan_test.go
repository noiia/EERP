package scan_test

import (
	"errors"
	"testing"
	"time"

	"core/orm/internal/cache"
	"core/orm/internal/scan"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── mock pgx.Rows ─────────────────────────────────────────────────────────────

// mockRows satisfies pgx.Rows without a real database connection.
type mockRows struct {
	cols    []string
	data    [][]any
	pos     int
	err     error
	scanErr error
	closed  bool
}

func newMockRows(cols []string, data [][]any) *mockRows {
	return &mockRows{cols: cols, data: data, pos: -1}
}

func (r *mockRows) FieldDescriptions() []pgconn.FieldDescription {
	fds := make([]pgconn.FieldDescription, len(r.cols))
	for i, c := range r.cols {
		fds[i] = pgconn.FieldDescription{Name: c}
	}
	return fds
}

func (r *mockRows) Next() bool {
	r.pos++
	return r.pos < len(r.data)
}

func (r *mockRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	row := r.data[r.pos]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		setPtr(d, row[i])
	}
	return nil
}

func (r *mockRows) Close()                        { r.closed = true }
func (r *mockRows) Err() error                    { return r.err }
func (r *mockRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (r *mockRows) Values() ([]any, error)        { return nil, nil }
func (r *mockRows) RawValues() [][]byte           { return nil }
func (r *mockRows) Conn() *pgx.Conn               { return nil }

// setPtr writes val into the pointer dest using a type switch.
// Covers every type used in test fixtures.
func setPtr(dest, val any) {
	if val == nil {
		return
	}
	switch d := dest.(type) {
	case **int:
		v := val.(int)
		*d = &v
	case *int:
		*d = val.(int)
	case **string:
		v := val.(string)
		*d = &v
	case *string:
		*d = val.(string)
	case **time.Time:
		v := val.(time.Time)
		*d = &v
	case *time.Time:
		*d = val.(time.Time)
	case *any:
		*d = val
	}
}

// ── mock pgx.Row ──────────────────────────────────────────────────────────────

type mockRow struct {
	vals []any
	err  error
}

func (r *mockRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		if i >= len(r.vals) {
			break
		}
		setPtr(d, r.vals[i])
	}
	return nil
}

// ── fixtures ──────────────────────────────────────────────────────────────────

type flat struct {
	ID   int    `db:"id,pk"`
	Name string `db:"name"`
	Age  int    `db:"age"`
}

type withPtr struct {
	ID        int        `db:"id,pk"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
}

type embBase struct {
	ID   int    `db:"id,pk"`
	Name string `db:"name"`
}

type order struct {
	embBase
	Status string `db:"status"`
}

// ── Rows ──────────────────────────────────────────────────────────────────────

func TestRows_Empty(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[flat]()
	rows := newMockRows([]string{"id", "name", "age"}, nil)

	result, err := scan.Rows[flat](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected empty slice, got %d", len(result))
	}
	if !rows.closed {
		t.Error("rows must be closed after Rows()")
	}
}

func TestRows_SingleRow(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[flat]()
	rows := newMockRows(
		[]string{"id", "name", "age"},
		[][]any{{1, "alice", 30}},
	)

	result, err := scan.Rows[flat](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 result, got %d", len(result))
	}
	got := result[0]
	if got.ID != 1 || got.Name != "alice" || got.Age != 30 {
		t.Errorf("got %+v", got)
	}
}

func TestRows_MultipleRows(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[flat]()
	rows := newMockRows(
		[]string{"id", "name", "age"},
		[][]any{{1, "alice", 30}, {2, "bob", 25}, {3, "carol", 35}},
	)

	result, err := scan.Rows[flat](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 3 {
		t.Errorf("expected 3 results, got %d", len(result))
	}
	if result[1].Name != "bob" {
		t.Errorf("result[1].Name = %q, want %q", result[1].Name, "bob")
	}
}

func TestRows_ColumnOrderIndependent(t *testing.T) {
	t.Parallel()

	// Columns arrive in a different order than struct field declaration.
	meta, err := cache.Get[flat]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	rows := newMockRows(
		[]string{"age", "name", "id"},
		[][]any{{30, "alice", 1}},
	)

	result, err := scan.Rows[flat](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := result[0]
	if got.ID != 1 || got.Name != "alice" || got.Age != 30 {
		t.Errorf("got %+v", got)
	}
}

func TestRows_ExtraColumnsIgnored(t *testing.T) {
	t.Parallel()

	// Query returns columns the struct doesn't have — must be silently skipped.
	meta, _ := cache.Get[flat]()
	rows := newMockRows(
		[]string{"id", "name", "age", "irrelevant"},
		[][]any{{1, "alice", 30, "extra"}},
	)

	result, err := scan.Rows[flat](rows, meta)
	if err != nil {
		t.Fatalf("extra columns must be silently ignored, got: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 result, got %d", len(result))
	}
}

func TestRows_NullPointerField_NilResult(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[withPtr]()
	rows := newMockRows(
		[]string{"id", "deleted_at"},
		[][]any{{1, nil}},
	)

	result, err := scan.Rows[withPtr](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result[0].DeletedAt != nil {
		t.Error("DeletedAt should be nil for NULL column")
	}
}

func TestRows_NonNullPointerField(t *testing.T) {
	t.Parallel()

	now := time.Now().Truncate(time.Second)
	meta, _ := cache.Get[withPtr]()
	rows := newMockRows(
		[]string{"id", "deleted_at"},
		[][]any{{1, now}},
	)

	result, err := scan.Rows[withPtr](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result[0].DeletedAt == nil {
		t.Fatal("DeletedAt should not be nil")
	}
	if !result[0].DeletedAt.Equal(now) {
		t.Errorf("DeletedAt = %v, want %v", result[0].DeletedAt, now)
	}
}

func TestRows_EmbeddedStruct(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[order]()
	rows := newMockRows(
		[]string{"id", "name", "status"},
		[][]any{{7, "acme", "open"}},
	)

	result, err := scan.Rows[order](rows, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := result[0]
	if got.ID != 7 || got.Name != "acme" || got.Status != "open" {
		t.Errorf("got %+v", got)
	}
}

func TestRows_ScanError_Propagated(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[flat]()
	rows := newMockRows([]string{"id", "name", "age"}, [][]any{{1, "alice", 30}})
	rows.scanErr = errors.New("injected scan failure")

	_, err := scan.Rows[flat](rows, meta)
	if err == nil {
		t.Fatal("expected error from scan failure")
	}
}

func TestRows_IterationError_Propagated(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[flat]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rows := newMockRows([]string{"id", "name", "age"}, nil)
	rows.err = errors.New("network interrupted")

	_, err = scan.Rows[flat](rows, meta)
	if err == nil {
		t.Fatal("expected error from rows.Err()")
	}
}

func TestRows_AlwaysCloses(t *testing.T) {
	t.Parallel()

	// Even on scan failure, rows.Close() must be called (defer).
	meta, _ := cache.Get[flat]()
	rows := newMockRows([]string{"id", "name", "age"}, [][]any{{1, "x", 0}})
	rows.scanErr = errors.New("injected")

	scan.Rows[flat](rows, meta) //nolint:errcheck
	if !rows.closed {
		t.Error("rows.Close() must be called even when scan fails")
	}
}

// ── Row ───────────────────────────────────────────────────────────────────────

func TestRow_Success(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[flat]()
	row := &mockRow{vals: []any{42, "dave", 28}}

	got, err := scan.Row[flat](row, meta)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != 42 || got.Name != "dave" || got.Age != 28 {
		t.Errorf("got %+v", got)
	}
}

func TestRow_Error_Propagated(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[flat]()
	row := &mockRow{err: errors.New("no rows in result set")}

	_, err := scan.Row[flat](row, meta)
	if err == nil {
		t.Fatal("expected error for failed scan")
	}
}
