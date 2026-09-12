package module_test

import (
	"testing"

	"core/internal/module"
	_ "core/modules/all" // triggers init() → RegisterGoModule for each module
	"core/orm"
)

// TestGoModules_InitEnlistsModules verifies that blank-importing modules/all
// causes each module's init() to call RegisterGoModule.
func TestGoModules_InitEnlistsModules(t *testing.T) {
	n := module.GoModuleCount()
	if n < 3 {
		t.Fatalf("expected at least 3 Go modules (contact, crm, crminheritdemo), got %d", n)
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

// TestGoModules_InheritanceExtendsTable verifies that crminheritdemo adds
// its fields to the crm table without the crm module knowing about it.
func TestGoModules_InheritanceExtendsTable(t *testing.T) {
	errs := module.RegisterSchemaOnly()
	for _, err := range errs {
		t.Errorf("Register() error: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("crm")
	if !ok {
		t.Fatal("crm table not in registry")
	}

	colNames := make(map[string]bool, len(fields))
	for _, f := range fields {
		colNames[f.Column] = true
	}

	for _, want := range []string{"date", "comment"} {
		if !colNames[want] {
			t.Errorf("crm table missing %q column — crminheritdemo extension did not apply", want)
		}
	}

	t.Logf("crm columns after inheritance: %v", func() []string {
		names := make([]string, 0, len(fields))
		for _, f := range fields {
			names = append(names, f.Column)
		}
		return names
	}())
}
