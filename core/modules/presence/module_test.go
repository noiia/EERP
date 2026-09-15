package presence

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

// user_presence must stay registered (so its schema migrates) but excluded
// from the generic CRUD surface — the dedicated handler in
// core/internal/presence is the only way in.
func TestPresence_RegisteredButNotExposed(t *testing.T) {
	if err := (&presenceModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	registered := orm.RegisteredTableNames()
	exposed := orm.ExposedTableNames()

	if !contains(registered, "user_presence") {
		t.Error("user_presence must stay registered so its schema still migrates")
	}
	if contains(exposed, "user_presence") {
		t.Error("user_presence must NOT be exposed on the generic CRUD surface")
	}
}

// The table must carry every column the upsert/effective-status logic
// depends on (see core/internal/presence's models.go/status.go).
func TestPresence_HasStatusColumns(t *testing.T) {
	if err := (&presenceModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("user_presence")
	if !ok {
		t.Fatal("user_presence table not registered")
	}
	want := map[string]bool{
		"tenant_id": false, "user_id": false, "manual_status": false,
		"connected": false, "last_seen": false,
	}
	for _, f := range fields {
		if _, ok := want[f.Column]; ok {
			want[f.Column] = true
		}
	}
	for col, found := range want {
		if !found {
			t.Errorf("user_presence is missing %s", col)
		}
	}
}
