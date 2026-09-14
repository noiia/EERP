package contact

import (
	"testing"

	"core/orm"
)

// The contact table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a). Without it,
// contacts would be global and readable across tenants.
func TestContact_IsTenantScoped(t *testing.T) {
	if err := (&contactModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("contact")
	if !ok {
		t.Fatal("contact table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("contact is missing tenant_id — tenant isolation would not apply")
}
