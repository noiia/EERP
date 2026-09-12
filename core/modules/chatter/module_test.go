package chatter

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

// chatter_message must stay registered (so its schema migrates) but excluded
// from the generic CRUD surface — the anchor-scoped, tenant-pinned handler in
// core/internal/chatter is the only way in.
func TestChatter_RegisteredButNotExposed(t *testing.T) {
	if err := (&chatterModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	registered := orm.RegisteredTableNames()
	exposed := orm.ExposedTableNames()

	if !contains(registered, "chatter_message") {
		t.Error("chatter_message must stay registered so its schema still migrates")
	}
	if contains(exposed, "chatter_message") {
		t.Error("chatter_message must NOT be exposed on the generic CRUD surface")
	}
}

// The table must carry every column the anchor lookup and author snapshot
// depend on.
func TestChatter_HasAnchorAndAuthorColumns(t *testing.T) {
	if err := (&chatterModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("chatter_message")
	if !ok {
		t.Fatal("chatter_message table not registered")
	}
	want := map[string]bool{
		"tenant_id": false, "table_name": false, "record_id": false,
		"author_id": false, "author_email": false, "kind": false, "body": false,
	}
	for _, f := range fields {
		if _, ok := want[f.Column]; ok {
			want[f.Column] = true
		}
	}
	for col, found := range want {
		if !found {
			t.Errorf("chatter_message is missing %s", col)
		}
	}
}
