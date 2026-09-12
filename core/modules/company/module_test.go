package company

import (
	"testing"

	"core/orm"
)

// The company table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestCompany_IsTenantScoped(t *testing.T) {
	if err := (&companyModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("company")
	if !ok {
		t.Fatal("company table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("company is missing tenant_id — tenant isolation would not apply")
}
