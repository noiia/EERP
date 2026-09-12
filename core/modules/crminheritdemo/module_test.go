package crminheritdemo

import (
	"testing"

	"core/orm"
)

// Extension columns added to ANOTHER module's table must be nullable: a NOT NULL
// column becomes required on every create of the base table, 422-ing writers that
// don't know the extension exists (the crm form, plain API clients). Pointer
// fields register as nullable — this pins that contract for date and comment.
func TestExtensionColumnsAreNullable(t *testing.T) {
	if err := (&crminheritdemoModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("crm")
	if !ok {
		t.Fatal("crm table not registered")
	}

	extension := map[string]bool{"date": true, "comment": true}
	seen := 0
	for _, f := range fields {
		if !extension[f.Column] {
			continue
		}
		seen++
		if !f.Nullable {
			t.Errorf("extension column %q is NOT NULL — it would break every writer of the base table", f.Column)
		}
	}
	if seen != len(extension) {
		t.Errorf("expected %d extension columns on crm, found %d", len(extension), seen)
	}
}
