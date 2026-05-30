package log

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// Logger is the minimal interface the ORM requires for query observability.
// Implement it with any backend — the ORM only calls Log.
type Logger interface {
	Log(ctx context.Context, entry LogEntry)
}

// LogEntry carries the full context of one query execution.
type LogEntry struct {
	SQL      string
	Args     []any
	Duration time.Duration
	Err      error
}

// ── ZapLogger ─────────────────────────────────────────────────────────────────

// ZapLogger wraps a *zap.Logger and satisfies Logger.
// On error it logs at Error level; on success at Debug level.
type ZapLogger struct {
	z *zap.Logger
}

// NewZapLogger constructs a ZapLogger from an existing *zap.Logger.
// Typically you pass the application-level logger here.
func NewZapLogger(z *zap.Logger) *ZapLogger {
	return &ZapLogger{z: z}
}

// Log emits a structured log entry.
// Error queries are logged at zap.Error; successful queries at zap.Debug.
func (l *ZapLogger) Log(_ context.Context, e LogEntry) {
	fields := l.toFields(e)
	if e.Err != nil {
		l.z.Error("orm: query error", fields...)
		return
	}
	l.z.Debug("orm: query", fields...)
}

// toFields maps a LogEntry to the typed zap.Field slice.
// Each field uses the most specific zap type for minimal allocation:
//   - zap.String  for the SQL text
//   - zap.Any     for the args slice (types unknown at compile time)
//   - zap.Duration for the wall-clock execution time
//   - zap.Error   only appended when Err != nil
func (l *ZapLogger) toFields(e LogEntry) []zap.Field {
	fields := []zap.Field{
		zap.String("sql", e.SQL),
		zap.Any("args", e.Args),
		zap.Duration("duration", e.Duration),
	}
	if e.Err != nil {
		fields = append(fields, zap.Error(e.Err))
	}
	return fields
}

// ── NoopLogger ────────────────────────────────────────────────────────────────

// NoopLogger discards every log entry with zero overhead.
// It is the default logger when none is provided to DB.
type NoopLogger struct{}

func (NoopLogger) Log(_ context.Context, _ LogEntry) {}
