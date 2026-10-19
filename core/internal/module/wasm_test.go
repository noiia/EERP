package module_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"core/internal/module"
	"core/internal/testdb"
	"core/internal/types"
	"core/orm"

	"github.com/bytecodealliance/wasmtime-go/v49"
	"github.com/google/uuid"
)

// wasmModule compiles a minimal WASM module from WebAssembly text: its linear
// memory holds the migration JSON, migrate() returns where, migrate_len() how
// long — the whole ABI loadModule reads. No toolchain needed beyond wasmtime.
func wasmModule(t *testing.T, m types.Migration) []byte {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	escaped := strings.ReplaceAll(strings.ReplaceAll(string(raw), `\`, `\\`), `"`, `\"`)
	wat := fmt.Sprintf(`(module
		(memory (export "memory") 1)
		(data (i32.const 16) "%s")
		(func (export "migrate") (result i32) (i32.const 16))
		(func (export "migrate_len") (result i32) (i32.const %d)))`, escaped, len(raw))
	bin, err := wasmtime.Wat2Wasm(wat)
	if err != nil {
		t.Fatalf("wat2wasm: %v", err)
	}
	return bin
}

// writeModule lays out <root>/<dir>/module.json + module.wasm.
func writeModule(t *testing.T, root, dir string, manifest map[string]any, wasm []byte) string {
	t.Helper()
	modDir := filepath.Join(root, dir)
	if err := os.MkdirAll(modDir, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(modDir, "module.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modDir, "module.wasm"), wasm, 0o644); err != nil {
		t.Fatal(err)
	}
	return modDir
}

func columnExists(t *testing.T, db *orm.DB, table, column string) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2)`, table, column).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

// A WASM-type module's whole live lifecycle: boot loads it (its migration
// creates the table and columns, its schema gets CRUD-registered, the table
// is attributed to it), deactivating flips the gate and module.json, a
// reload re-instantiates a replaced binary and applies its new migration,
// and every step is in the module's operation log.
func TestRegistry_WasmModuleLifecycle(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	// The detector caches snapshots under ./cache — keep them in a temp dir.
	t.Chdir(t.TempDir())
	root := t.TempDir()

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	name := "wasmdemo_" + suffix
	table := "wasmdemo_" + suffix
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DROP TABLE IF EXISTS `+table)
		_, _ = app.DB.Exec(ctx, `DELETE FROM module_migrations WHERE module_name = $1`, name)
		_, _ = app.DB.Exec(ctx, `DELETE FROM module_operation_log WHERE module_name = $1`, name)
	})

	v1 := types.Migration{Entity: table, Version: 1, Operations: []types.Operation{
		{Type: "add_column", Table: table, Column: "title", SQLType: "TEXT", Nullable: true, Index: true},
	}}
	manifest := map[string]any{"name": name, "type": "wasm", "active": true, "version": "1.0.0", "depends": []string{}}
	modDir := writeModule(t, root, name, manifest, wasmModule(t, v1))

	engine := wasmtime.NewEngine()
	linker := wasmtime.NewLinker(engine)
	if err := linker.DefineWasi(); err != nil {
		t.Fatal(err)
	}
	reg := module.NewRegistry(engine, linker, app.DB, []string{root})

	if errs := reg.Boot(ctx); len(errs) != 0 {
		t.Fatalf("boot: %v", errs)
	}
	if !columnExists(t, app.DB, table, "title") {
		t.Fatalf("boot did not apply the migration: %s.title missing", table)
	}
	if fields, ok := orm.MigrationFieldsForTable(table); !ok || len(fields) == 0 {
		t.Errorf("boot did not register %s's schema", table)
	}
	if !reg.IsActive(name) || !reg.IsTableActive(table) {
		t.Errorf("active module's table should be active")
	}
	// A second boot finds the migration already applied.
	if errs := reg.Boot(ctx); len(errs) != 0 {
		t.Fatalf("second boot: %v", errs)
	}

	// Deactivate: the gate flips at once, and module.json follows.
	if _, err := reg.SetActive(ctx, name, false); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if reg.IsTableActive(table) {
		t.Error("a deactivated module's table must be gated")
	}
	raw, _ := os.ReadFile(filepath.Join(modDir, "module.json"))
	if !strings.Contains(string(raw), `"active": false`) && !strings.Contains(string(raw), `"active":false`) {
		t.Errorf("module.json not updated: %s", raw)
	}
	if _, err := reg.SetActive(ctx, name, true); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	if _, err := reg.SetActive(ctx, "no_such_module", true); !errors.Is(err, module.ErrModuleNotFound) {
		t.Errorf("SetActive(unknown) = %v, want ErrModuleNotFound", err)
	}

	// Reload a replaced binary: its version 2 migration adds a column.
	v2 := types.Migration{Entity: table, Version: 2, Operations: []types.Operation{
		{Type: "add_column", Table: table, Column: "body", SQLType: "TEXT", Nullable: true},
		{Type: "create_index", Table: table, Column: "body", IndexType: "btree"},
	}}
	if err := os.WriteFile(filepath.Join(modDir, "module.wasm"), wasmModule(t, v2), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Reload(ctx, name); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !columnExists(t, app.DB, table, "body") {
		t.Errorf("reload did not apply version 2: %s.body missing", table)
	}
	if _, err := reg.Reload(ctx, "no_such_module"); !errors.Is(err, module.ErrModuleNotFound) {
		t.Errorf("Reload(unknown) = %v, want ErrModuleNotFound", err)
	}

	logs, err := reg.Logs(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	ops := map[string]bool{}
	for _, l := range logs {
		ops[l.Operation] = true
	}
	for _, op := range []string{"activate", "deactivate", "reload"} {
		if !ops[op] {
			t.Errorf("no %q in the operation log: %+v", op, ops)
		}
	}
}

// A module whose binary isn't valid WASM fails its load — reported, not fatal
// to the rest of the boot.
func TestRegistry_BrokenWasmModule(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	t.Chdir(t.TempDir())
	root := t.TempDir()
	name := "wasmbroken_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	writeModule(t, root, name, map[string]any{"name": name, "type": "wasm", "active": true, "depends": []string{}}, []byte("not wasm"))

	engine := wasmtime.NewEngine()
	reg := module.NewRegistry(engine, wasmtime.NewLinker(engine), app.DB, []string{root})
	errs := reg.Boot(ctx)
	if len(errs) != 1 {
		t.Fatalf("boot errors = %v, want exactly the broken module's", errs)
	}
	// Still discovered: its gate state is known even though it didn't load.
	if !reg.IsActive(name) {
		t.Error("the broken module should still be known (and active)")
	}
}
