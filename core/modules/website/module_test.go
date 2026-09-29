package website

import (
	"testing"

	"core/orm"
)

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestWebsite_IsTenantScoped(t *testing.T) {
	if err := (&websiteModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("website_page")
	if !ok {
		t.Fatal("website_page table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("website is missing tenant_id — tenant isolation would not apply")
}
