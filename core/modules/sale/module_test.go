package sale

import (
	"testing"

	"core/orm"
)

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestInvoice_IsTenantScoped(t *testing.T) {
	if err := (&saleModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("invoice")
	if !ok {
		t.Fatal("invoice table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("invoice is missing tenant_id — tenant isolation would not apply")
}
