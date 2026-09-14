package notebook

import (
	"testing"

	"core/orm"
)

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// notebook_page must stay registered (so its schema migrates) but excluded
// from the generic CRUD surface — a tenant must never enumerate or write
// another tenant's/entity's runtime pages except through the anchor-scoped
// handlers in internal/notebook (docs/roadmaps/responsive-displays.md, Phase 5).
func TestNotebookPage_RegisteredButNotExposed(t *testing.T) {
	if err := (&notebookModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	registered := orm.RegisteredTableNames()
	exposed := orm.ExposedTableNames()

	if !contains(registered, "notebook_page") {
		t.Error("notebook_page must stay registered so its schema still migrates")
	}
	if contains(exposed, "notebook_page") {
		t.Error("notebook_page must NOT be exposed on the generic CRUD surface")
	}
}

// The table must carry tenant_id/table_name/record_id so a page anchor is
// fully scoped — the columns the List/Create handlers query on.
func TestNotebookPage_HasAnchorColumns(t *testing.T) {
	if err := (&notebookModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("notebook_page")
	if !ok {
		t.Fatal("notebook_page table not registered")
	}
	want := map[string]bool{"tenant_id": false, "table_name": false, "record_id": false}
	for _, f := range fields {
		if _, ok := want[f.Column]; ok {
			want[f.Column] = true
		}
	}
	for col, found := range want {
		if !found {
			t.Errorf("notebook_page is missing %s — anchor scoping would not apply", col)
		}
	}
}
