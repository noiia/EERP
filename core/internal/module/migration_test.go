package module

import (
	"context"
	"strings"
	"testing"

	"core/internal/common"
	"core/internal/types"
	"core/orm"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go.uber.org/zap"
)

// createIndex logs the emitted DDL; the package Logger is only initialized by
// the app entrypoint, so tests provide a no-op one.
func init() {
	if common.Logger == nil {
		common.Logger = zap.NewNop()
	}
}

// recordingExec captures every Exec'd SQL statement — the DDL helpers take the
// call-site orm.Executor interface, so index/column emission is asserted without
// a live Postgres (the statements are IF NOT EXISTS, so correctness on rerun is
// a property of the SQL itself).
type recordingExec struct {
	sql []string
}

func (r *recordingExec) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, nil }
func (r *recordingExec) QueryRow(context.Context, string, ...any) pgx.Row        { return nil }
func (r *recordingExec) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	r.sql = append(r.sql, sql)
	return pgconn.CommandTag{}, nil
}

func field(col, method string, indexed bool) orm.MigrationField {
	return orm.MigrationField{Column: col, SQLType: "TEXT", Nullable: true, Index: indexed, IndexType: method}
}

func TestEnsureIndexes_EmitsEveryMethod(t *testing.T) {
	tests := []struct {
		name  string
		field orm.MigrationField
		want  string // "" = no statement expected
	}{
		{name: "untagged column is skipped", field: field("plain", "", false), want: ""},
		{name: "bare index defaults to btree", field: field("status", "", true),
			want: "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders USING btree (status)"},
		{name: "hash", field: field("code", "hash", true),
			want: "CREATE INDEX IF NOT EXISTS idx_orders_code ON orders USING hash (code)"},
		{name: "gist", field: field("area", "gist", true),
			want: "CREATE INDEX IF NOT EXISTS idx_orders_area ON orders USING gist (area)"},
		{name: "spgist", field: field("route", "spgist", true),
			want: "CREATE INDEX IF NOT EXISTS idx_orders_route ON orders USING spgist (route)"},
		{name: "gin", field: field("tags", "gin", true),
			want: "CREATE INDEX IF NOT EXISTS idx_orders_tags ON orders USING gin (tags)"},
		{name: "brin", field: field("logged_at", "brin", true),
			want: "CREATE INDEX IF NOT EXISTS idx_orders_logged_at ON orders USING brin (logged_at)"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exec := &recordingExec{}
			if err := ensureIndexes(context.Background(), exec, "orders", []orm.MigrationField{tt.field}); err != nil {
				t.Fatalf("ensureIndexes: %v", err)
			}
			if tt.want == "" {
				if len(exec.sql) != 0 {
					t.Fatalf("expected no DDL, got %v", exec.sql)
				}
				return
			}
			if len(exec.sql) != 1 || exec.sql[0] != tt.want {
				t.Fatalf("DDL = %v, want [%s]", exec.sql, tt.want)
			}
		})
	}
}

func TestEnsureIndexes_RerunEmitsIdenticalIdempotentDDL(t *testing.T) {
	fields := []orm.MigrationField{field("status", "gin", true)}
	first := &recordingExec{}
	second := &recordingExec{}
	if err := ensureIndexes(context.Background(), first, "orders", fields); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := ensureIndexes(context.Background(), second, "orders", fields); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if len(first.sql) != 1 || first.sql[0] != second.sql[0] {
		t.Fatalf("reruns differ: %v vs %v", first.sql, second.sql)
	}
	if !strings.Contains(first.sql[0], "IF NOT EXISTS") {
		t.Fatalf("index DDL is not idempotent: %s", first.sql[0])
	}
}

func TestCreateIndex_FromMigrationOperation(t *testing.T) {
	tests := []struct {
		name string
		op   types.Operation
		want string
	}{
		{
			name: "explicit method",
			op:   types.Operation{Table: "invoices", Column: "payload", IndexType: "gin"},
			want: "CREATE INDEX IF NOT EXISTS idx_invoices_payload ON invoices USING gin (payload)",
		},
		{
			name: "missing method defaults to btree",
			op:   types.Operation{Table: "invoices", Column: "status"},
			want: "CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices USING btree (status)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exec := &recordingExec{}
			if err := createIndex(context.Background(), exec, tt.op); err != nil {
				t.Fatalf("createIndex: %v", err)
			}
			if len(exec.sql) != 1 || exec.sql[0] != tt.want {
				t.Fatalf("DDL = %v, want [%s]", exec.sql, tt.want)
			}
		})
	}
}

func TestEnsureColumns_NotNullGetsAZeroDefault(t *testing.T) {
	// A required (non-pointer, non-PK) field's ADD COLUMN must carry a
	// DEFAULT — otherwise it fails outright against a table that already has
	// rows (the common case: a module adds a required field after its table
	// has data). Nullable/PK columns get neither NOT NULL nor a default.
	tests := []struct {
		name  string
		field orm.MigrationField
		want  string
	}{
		{
			name:  "required text column backfills empty string",
			field: orm.MigrationField{Column: "issuer_name", SQLType: "TEXT", Nullable: false},
			want:  "ALTER TABLE invoice ADD COLUMN IF NOT EXISTS issuer_name TEXT NOT NULL DEFAULT ''",
		},
		{
			name:  "required boolean column backfills false",
			field: orm.MigrationField{Column: "active", SQLType: "BOOLEAN", Nullable: false},
			want:  "ALTER TABLE invoice ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT false",
		},
		{
			name:  "required numeric column backfills zero",
			field: orm.MigrationField{Column: "rank", SQLType: "INTEGER", Nullable: false},
			want:  "ALTER TABLE invoice ADD COLUMN IF NOT EXISTS rank INTEGER NOT NULL DEFAULT 0",
		},
		{
			name:  "nullable column gets no NOT NULL or default",
			field: orm.MigrationField{Column: "reference", SQLType: "TEXT", Nullable: true},
			want:  "ALTER TABLE invoice ADD COLUMN IF NOT EXISTS reference TEXT",
		},
		{
			name:  "primary key gets no NOT NULL or default",
			field: orm.MigrationField{Column: "code", SQLType: "UUID", Nullable: false, IsPK: true},
			want:  "ALTER TABLE invoice ADD COLUMN IF NOT EXISTS code UUID",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exec := &recordingExec{}
			if err := ensureColumns(context.Background(), exec, "invoice", []orm.MigrationField{tt.field}); err != nil {
				t.Fatalf("ensureColumns: %v", err)
			}
			if len(exec.sql) != 1 || exec.sql[0] != tt.want {
				t.Fatalf("DDL = %v, want [%s]", exec.sql, tt.want)
			}
		})
	}
}
