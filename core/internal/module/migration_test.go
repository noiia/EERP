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

func TestAutoMigrateTable_TableThenColumnsThenIndexes(t *testing.T) {
	exec := &recordingExec{}
	fields := []orm.MigrationField{
		{Column: "id", SQLType: "UUID", IsPK: true}, // BaseModel column: no ALTER
		field("status", "hash", true),
	}
	if err := autoMigrateTable(context.Background(), exec, "orders", fields); err != nil {
		t.Fatalf("autoMigrateTable: %v", err)
	}
	if len(exec.sql) != 3 {
		t.Fatalf("expected 3 statements (create, alter, index), got %d: %v", len(exec.sql), exec.sql)
	}
	if !strings.Contains(exec.sql[0], "CREATE TABLE IF NOT EXISTS orders") {
		t.Errorf("statement 1 = %s, want CREATE TABLE", exec.sql[0])
	}
	if !strings.Contains(exec.sql[1], "ALTER TABLE orders ADD COLUMN IF NOT EXISTS status") {
		t.Errorf("statement 2 = %s, want ALTER TABLE ADD COLUMN status", exec.sql[1])
	}
	if !strings.Contains(exec.sql[2], "CREATE INDEX IF NOT EXISTS idx_orders_status") {
		t.Errorf("statement 3 = %s, want CREATE INDEX", exec.sql[2])
	}
}
