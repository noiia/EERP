package propertymanagement

import (
	"testing"

	"core/orm"
)

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestPropertyManagement_TablesAreTenantScoped(t *testing.T) {
	if err := (&propertyManagementModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	tables := []string{
		"property_management",
		"property_management_tenant",
		"property_management_photo",
		"property_management_equipment",
		"property_management_equipment_status",
		"property_management_equipment_photo",
		"property_management_rent_receipt",
	}
	for _, table := range tables {
		fields, ok := orm.MigrationFieldsForTable(table)
		if !ok {
			t.Fatalf("%s table not registered", table)
		}
		hasTenant := false
		for _, f := range fields {
			if f.Column == "tenant_id" {
				hasTenant = true
			}
		}
		if !hasTenant {
			t.Errorf("%s is missing tenant_id — tenant isolation would not apply", table)
		}
	}
}
