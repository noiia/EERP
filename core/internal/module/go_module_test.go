package module_test

import (
	"testing"

	"core/internal/module"
	"core/orm"
	_ "core/modules/all" // triggers init() → RegisterGoModule for each module
)

// TestGoModules_InitEnlistsModules verifies that blank-importing modules/all
// causes each module's init() to call RegisterGoModule.
func TestGoModules_InitEnlistsModules(t *testing.T) {
	n := module.GoModuleCount()
	if n == 0 {
		t.Fatal("no Go modules enlisted — check that modules/all blank-imports are in place and init() calls RegisterGoModule")
	}
	t.Logf("%d Go module(s) enlisted via init()", n)
}

// TestGoModules_RegisterAddsToORM verifies that calling Register() on each
// enlisted module adds its table(s) to the ORM registry, which is what
// BuildHandlers reads to mount API routes.
func TestGoModules_RegisterAddsToORM(t *testing.T) {
	errs := module.RegisterSchemaOnly()
	for _, err := range errs {
		t.Errorf("Register() error: %v", err)
	}

	tables := orm.RegisteredTableNames()
	if len(tables) == 0 {
		t.Fatal("ORM registry is empty after Register() — BuildHandlers will mount no routes")
	}
	t.Logf("tables in ORM registry (= future API routes): %v", tables)

	for _, name := range tables {
		fields, ok := orm.MigrationFieldsForTable(name)
		if !ok {
			t.Errorf("MigrationFieldsForTable(%q) returned false", name)
			continue
		}
		if len(fields) == 0 {
			t.Errorf("table %q has zero fields", name)
		}
		t.Logf("  /api/v1/%s — %d columns", name, len(fields))
	}
}
