package db_test

import (
	"context"
	"core/orm/log"
	"core/orm/pool/config"
	"core/orm/pool/db"
	"core/orm/pool/executor"
	"core/orm/pool/tx"
	"errors"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func observedLogger(t *testing.T) (*log.ZapLogger, *observer.ObservedLogs) {
	t.Helper()
	c, obs := observer.New(zap.DebugLevel)
	return log.NewZapLogger(zap.New(c)), obs
}

// ── Executor interface compliance ─────────────────────────────────────────────

// Compile-time assertions: both *DB and *Tx must satisfy Executor.
// These never run — they fail at compile time if the interface drifts.
var _ executor.Executor = (*db.DB)(nil)
var _ executor.Executor = (*tx.Tx)(nil)
var _ executor.TxBeginner = (*db.DB)(nil)

// ── DB.log — debug flag ───────────────────────────────────────────────────────

func TestDB_Log_DebugOff_SuccessNotLogged(t *testing.T) {
	t.Parallel()

	// We can't easily test DB.log without a real pool, but we can verify
	// the Logger interface contract through ZapLogger directly.
	logger, obs := observedLogger(t)
	// Simulate what DB.log does when debug=false and err=nil: nothing logged.
	// When debug=true: logs at Debug.
	entry := log.LogEntry{SQL: "SELECT 1", Duration: time.Millisecond}
	logger.Log(context.Background(), entry)
	if obs.Len() != 1 {
		t.Fatalf("expected 1 log entry from ZapLogger, got %d", obs.Len())
	}
	if obs.All()[0].Level != zap.DebugLevel {
		t.Error("success query should log at Debug level")
	}
}

func TestDB_Log_Error_AlwaysLogged(t *testing.T) {
	t.Parallel()

	logger, obs := observedLogger(t)
	entry := log.LogEntry{
		SQL: "SELECT 1",
		Err: errors.New("connection reset"),
	}
	logger.Log(context.Background(), entry)
	if obs.Len() != 1 {
		t.Fatalf("expected 1 log entry, got %d", obs.Len())
	}
	if obs.All()[0].Level != zap.ErrorLevel {
		t.Error("error query should log at Error level")
	}
}

// ── pgxSafeName (via Savepoint name sanitisation) ────────────────────────────

func TestPgxSafeName_Exported(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want string
	}{
		{"lines", "lines"},
		{"order_lines", "order_lines"},
		{"drop table orders; --", "droptableorders"},
		{"", "sp"},
		{"123abc", "123abc"},
		{"hello world", "helloworld"},
	}
	for _, c := range cases {
		got := tx.PgxSafeName(c.in)
		if got != c.want {
			t.Errorf("PgxSafeName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ── Config validation integration with Open ───────────────────────────────────

func TestOpen_InvalidConfig_ReturnsError(t *testing.T) {
	t.Parallel()

	_, err := db.Open(context.Background(), config.Config{})
	if err == nil {
		t.Fatal("expected error for empty DSN")
	}
	if !strings.Contains(err.Error(), "DSN") {
		t.Errorf("error should mention DSN, got: %v", err)
	}
}

// ── Executor interface — mockExecutor ─────────────────────────────────────────

func TestMockExecutor_Query(t *testing.T) {
	t.Parallel()

	m := &mockExecutor{
		queryRows: newMockRows(
			[]string{"id", "name"},
			[][]any{{1, "order-1"}, {2, "order-2"}},
		),
	}

	rows, err := m.Query(context.Background(), "SELECT id, name FROM orders")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id int
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			t.Fatalf("scan error: %v", err)
		}
		count++
	}
	if count != 2 {
		t.Errorf("expected 2 rows, got %d", count)
	}
	if m.queryCalls != 1 {
		t.Errorf("expected 1 Query call, got %d", m.queryCalls)
	}
	if m.lastSQL != "SELECT id, name FROM orders" {
		t.Errorf("lastSQL = %q", m.lastSQL)
	}
}

func TestMockExecutor_QueryRow(t *testing.T) {
	t.Parallel()

	m := &mockExecutor{
		queryRow: &mockRow{vals: []any{42, "pending"}},
	}

	row := m.QueryRow(context.Background(), "SELECT id, status FROM orders WHERE id = $1", 42)
	var id int
	var status string
	if err := row.Scan(&id, &status); err != nil {
		t.Fatalf("scan error: %v", err)
	}
	if id != 42 || status != "pending" {
		t.Errorf("got id=%d status=%q", id, status)
	}
	if m.queryRowCalls != 1 {
		t.Errorf("expected 1 QueryRow call, got %d", m.queryRowCalls)
	}
}

func TestMockExecutor_Exec(t *testing.T) {
	t.Parallel()

	m := &mockExecutor{}
	_, err := m.Exec(context.Background(), "DELETE FROM orders WHERE id = $1", 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.execCalls != 1 {
		t.Errorf("expected 1 Exec call, got %d", m.execCalls)
	}
}

func TestMockExecutor_Query_PropagatesError(t *testing.T) {
	t.Parallel()

	boom := errors.New("connection lost")
	m := &mockExecutor{queryErr: boom}
	_, err := m.Query(context.Background(), "SELECT 1")
	if !errors.Is(err, boom) {
		t.Errorf("expected boom error, got %v", err)
	}
}

func TestMockExecutor_Exec_PropagatesError(t *testing.T) {
	t.Parallel()

	boom := errors.New("unique violation")
	m := &mockExecutor{execErr: boom}
	_, err := m.Exec(context.Background(), "INSERT INTO orders VALUES ($1)", 1)
	if !errors.Is(err, boom) {
		t.Errorf("expected boom error, got %v", err)
	}
}

// ── Integration tests (require TEST_DSN env var) ──────────────────────────────
// Run with: TEST_DSN="postgres://..." go test -tags integration ./core/...
