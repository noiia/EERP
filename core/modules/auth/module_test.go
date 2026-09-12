package auth

import (
	"testing"

	"core/orm"
)

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// The auth tables must be managed by the ORM (so their schemas migrate) but must
// NOT be reachable through the generic HTTP CRUD surface — auto-CRUD on them is a
// privilege-escalation / cross-tenant integrity risk. See security-breach-rm.md #2.
func TestAuthTables_RegisteredButNotExposed(t *testing.T) {
	if err := (&authModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	registered := orm.RegisteredTableNames() // includes excluded (migration set)
	exposed := orm.ExposedTableNames()       // HTTP CRUD surface

	for _, tbl := range []string{"users", "roles", "permissions", "refresh_tokens"} {
		if !contains(registered, tbl) {
			t.Errorf("%s must stay registered so its schema still migrates", tbl)
		}
		if contains(exposed, tbl) {
			t.Errorf("%s must NOT be exposed on the generic CRUD surface", tbl)
		}
	}
}
