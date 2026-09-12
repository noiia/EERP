package warehouse

import (
	"testing"

	"core/orm"
)

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestWarehouse_TablesAreTenantScoped(t *testing.T) {
	if err := (&warehouseModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	for _, table := range []string{"product", "product_variant"} {
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

// ProductVariant.ProductID must never be nullable/zero-defaultable in a way
// that lets a variant exist without its parent product — "a variant can be
// created only based on an existing product.product."
func TestProductVariant_RequiresProduct(t *testing.T) {
	if err := (&warehouseModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("product_variant")
	if !ok {
		t.Fatal("product_variant table not registered")
	}
	for _, f := range fields {
		if f.Column == "product_id" && f.Nullable {
			t.Error("product_variant.product_id must be NOT NULL")
		}
	}
}
