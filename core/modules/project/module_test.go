package project

import (
	"testing"

	"core/orm"
)

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestProject_IsTenantScoped(t *testing.T) {
	if err := (&projectModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("project")
	if !ok {
		t.Fatal("project table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("project is missing tenant_id — tenant isolation would not apply")
}
