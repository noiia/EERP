package savedfilter

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

// saved_filter must stay registered (so its schema migrates) but excluded
// from the generic CRUD surface — visibility (private/shared) and the
// owner-only rename/delete check can only be enforced by the dedicated
// handler in core/internal/savedfilter (docs/adr/ADR-014-search-filter-bar.md).
func TestSavedFilter_RegisteredButNotExposed(t *testing.T) {
	if err := (&savedFilterModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	registered := orm.RegisteredTableNames()
	exposed := orm.ExposedTableNames()

	if !contains(registered, "saved_filter") {
		t.Error("saved_filter must stay registered so its schema still migrates")
	}
	if contains(exposed, "saved_filter") {
		t.Error("saved_filter must NOT be exposed on the generic CRUD surface")
	}
}

// The table must carry every column the visibility query and owner check
// depend on.
func TestSavedFilter_HasScopeColumns(t *testing.T) {
	if err := (&savedFilterModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("saved_filter")
	if !ok {
		t.Fatal("saved_filter table not registered")
	}
	want := map[string]bool{"tenant_id": false, "user_id": false, "entity": false, "name": false, "shared": false}
	for _, f := range fields {
		if _, ok := want[f.Column]; ok {
			want[f.Column] = true
		}
	}
	for col, found := range want {
		if !found {
			t.Errorf("saved_filter is missing %s", col)
		}
	}
}
