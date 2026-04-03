package db_test

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── mockRows ─────────────────────────────────────────────────────────────────

// mockRows implements pgx.Rows for testing ScanRows without a real database.
type mockRows struct {
	cols    []string
	data    [][]any
	pos     int
	scanErr error
	closed  bool
}

func newMockRows(cols []string, data [][]any) *mockRows {
	return &mockRows{cols: cols, data: data, pos: -1}
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
		switch v := d.(type) {
		case *int:
			*v = row[i].(int)
		case *string:
			*v = row[i].(string)
		}
	}
	return nil
}

func (r *mockRows) Close()                                       { r.closed = true }
func (r *mockRows) Err() error                                   { return nil }
func (r *mockRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *mockRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *mockRows) Values() ([]any, error)                       { return nil, nil }
func (r *mockRows) RawValues() [][]byte                          { return nil }
func (r *mockRows) Conn() *pgx.Conn                              { return nil }

// ── mockRow ───────────────────────────────────────────────────────────────────

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
		switch v := d.(type) {
		case *int:
			*v = r.vals[i].(int)
		case *string:
			*v = r.vals[i].(string)
		}
	}
	return nil
}

// ── mockExecutor ──────────────────────────────────────────────────────────────

// mockExecutor records calls and returns configured responses.
// It implements executor.Executor without touching a real database.
type mockExecutor struct {
	queryRows pgx.Rows
	queryErr  error
	queryRow  pgx.Row
	execTag   pgconn.CommandTag
	execErr   error

	queryCalls    int
	queryRowCalls int
	execCalls     int

	lastSQL  string
	lastArgs []any
}

func (m *mockExecutor) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	m.queryCalls++
	m.lastSQL = sql
	m.lastArgs = args
	if m.queryRows == nil {
		m.queryRows = newMockRows(nil, nil)
	}
	return m.queryRows, m.queryErr
}

func (m *mockExecutor) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	m.queryRowCalls++
	m.lastSQL = sql
	m.lastArgs = args
	if m.queryRow == nil {
		return &mockRow{err: errors.New("no row configured")}
	}
	return m.queryRow
}

func (m *mockExecutor) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	m.execCalls++
	m.lastSQL = sql
	m.lastArgs = args
	return m.execTag, m.execErr
}
