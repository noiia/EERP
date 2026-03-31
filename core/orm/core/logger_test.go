package core_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"core/orm/core"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

// ── NoopLogger ────────────────────────────────────────────────────────────────

func TestNoopLogger_NeverPanics(t *testing.T) {
	t.Parallel()

	l := core.NoopLogger{}
	// Should be a no-op with no panic — any args, any error.
	l.Log(context.Background(), core.LogEntry{
		SQL:      "SELECT 1",
		Args:     []any{1, "two"},
		Duration: time.Millisecond,
		Err:      errors.New("boom"),
	})
}

// ── ZapLogger ─────────────────────────────────────────────────────────────────

// zapObserver builds a ZapLogger backed by an in-memory observer so we can
// assert on emitted log entries without touching stdout.
func zapObserver(t *testing.T) (*core.ZapLogger, *observer.ObservedLogs) {
	t.Helper()
	core_, obs := observer.New(zap.DebugLevel)
	z := zap.New(core_)
	return core.NewZapLogger(z), obs
}

func TestZapLogger_SuccessQuery_LoggedAtDebug(t *testing.T) {
	t.Parallel()

	logger, obs := zapObserver(t)
	entry := core.LogEntry{
		SQL:      "SELECT id FROM orders WHERE id = $1",
		Args:     []any{42},
		Duration: 3 * time.Millisecond,
	}
	logger.Log(context.Background(), entry)

	logs := obs.All()
	if len(logs) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(logs))
	}
	if logs[0].Level != zap.DebugLevel {
		t.Errorf("level = %v, want Debug", logs[0].Level)
	}
	if logs[0].Message != "orm: query" {
		t.Errorf("message = %q, want %q", logs[0].Message, "orm: query")
	}
}

func TestZapLogger_ErrorQuery_LoggedAtError(t *testing.T) {
	t.Parallel()

	logger, obs := zapObserver(t)
	entry := core.LogEntry{
		SQL:      "INSERT INTO orders VALUES ($1)",
		Args:     []any{"bad"},
		Duration: time.Millisecond,
		Err:      errors.New("violates not-null constraint"),
	}
	logger.Log(context.Background(), entry)

	logs := obs.All()
	if len(logs) != 1 {
		t.Fatalf("expected 1 log entry, got %d", len(logs))
	}
	if logs[0].Level != zap.ErrorLevel {
		t.Errorf("level = %v, want Error", logs[0].Level)
	}
	if logs[0].Message != "orm: query error" {
		t.Errorf("message = %q, want %q", logs[0].Message, "orm: query error")
	}
}

func TestZapLogger_Fields_Presence(t *testing.T) {
	t.Parallel()

	logger, obs := zapObserver(t)
	logger.Log(context.Background(), core.LogEntry{
		SQL:      "SELECT 1",
		Args:     []any{},
		Duration: time.Second,
	})

	fields := obs.All()[0].ContextMap()
	for _, key := range []string{"sql", "args", "duration"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("expected field %q to be present in log entry", key)
		}
	}
}

func TestZapLogger_ErrorField_OnlyWhenErr(t *testing.T) {
	t.Parallel()

	logger, obs := zapObserver(t)

	// Without error — "error" key must be absent.
	logger.Log(context.Background(), core.LogEntry{SQL: "SELECT 1"})
	fields := obs.All()[0].ContextMap()
	if _, ok := fields["error"]; ok {
		t.Error("\"error\" field must not be present on successful query")
	}

	// With error — "error" key must be present.
	obs.TakeAll() // reset
	logger.Log(context.Background(), core.LogEntry{
		SQL: "SELECT 1",
		Err: errors.New("oops"),
	})
	fields = obs.All()[0].ContextMap()
	if _, ok := fields["error"]; !ok {
		t.Error("\"error\" field must be present when Err != nil")
	}
}

func TestZapLogger_ImplementsInterface(t *testing.T) {
	t.Parallel()

	// Compile-time check that both types satisfy Logger.
	var _ core.Logger = core.NewZapLogger(zap.NewNop())
	var _ core.Logger = core.NoopLogger{}
}
