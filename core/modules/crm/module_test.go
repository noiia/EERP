package crm

import (
	"testing"

	"core/orm"
)

// The crm table must carry a tenant_id column so the generic CRUD layer isolates
// rows per tenant (see security-breach-rm.md item 1/1a).
func TestCRM_IsTenantScoped(t *testing.T) {
	if err := (&crmModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("crm")
	if !ok {
		t.Fatal("crm table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("crm is missing tenant_id — tenant isolation would not apply")
}
