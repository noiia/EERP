package reportlayout

import (
	"testing"

	"core/orm"
)

// The report_page_format table must carry a tenant_id column so the generic
// CRUD layer isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestReportPageFormat_IsTenantScoped(t *testing.T) {
	if err := (&reportLayoutModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("report_page_format")
	if !ok {
		t.Fatal("report_page_format table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("report_page_format is missing tenant_id — tenant isolation would not apply")
}
