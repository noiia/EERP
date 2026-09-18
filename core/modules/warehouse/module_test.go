package warehouse

import (
	"testing"

	"core/orm"

	"github.com/google/uuid"
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

// defaultUoms' `kind` values must stay inside product_uoms_views.ts's closed
// `type` selection — a typo here would seed rows the frontend's quick-create
// wizard could never itself produce, and would silently drop out of any
// type-filtered picker.
func TestDefaultUoms_KindsMatchFrontendSelection(t *testing.T) {
	allowed := map[string]bool{"piece": true, "length": true, "weight": true, "volume": true, "surface": true, "custom": true}
	seenNames := map[string]bool{}
	for _, u := range defaultUoms {
		if !allowed[u.kind] {
			t.Errorf("default uom %q has kind %q, not in the frontend's selection options", u.name, u.kind)
		}
		if seenNames[u.name] {
			t.Errorf("default uom %q is declared more than once", u.name)
		}
		seenNames[u.name] = true
	}
}

// Every default uom carries a real symbol — a blank one would print as
// "<value> " (a trailing space, no unit) on a report table cell.
func TestDefaultUoms_HaveASymbol(t *testing.T) {
	for _, u := range defaultUoms {
		if u.symbol == "" {
			t.Errorf("default uom %q has no symbol", u.name)
		}
	}
}

// DefaultSurfaceUomNameMetric/Imperial must each name a REAL defaultUoms row
// of type "surface" — propertymanagement's own Create override looks them up
// by exactly this (name, type) pair to default a new property's floor_area
// uom_id (handler.go's defaultFloorAreaUom); a name drifting out of sync here
// would silently fall back to no default instead of failing loudly.
func TestDefaultSurfaceUomNames_ExistAsSurfaceUoms(t *testing.T) {
	for _, name := range []string{DefaultSurfaceUomNameMetric, DefaultSurfaceUomNameImperial} {
		found := false
		for _, u := range defaultUoms {
			if u.name == name {
				found = true
				if u.kind != "surface" {
					t.Errorf("%q is declared with kind %q, want \"surface\"", name, u.kind)
				}
			}
		}
		if !found {
			t.Errorf("%q is not declared in defaultUoms at all", name)
		}
	}
}

// seedUUID must be deterministic per (tenant, label) — that's the whole
// mechanism that makes re-running seedDefaultUoms on every boot idempotent
// via Upsert's ON CONFLICT (id) DO NOTHING.
func TestSeedUUID_DeterministicPerTenantAndLabel(t *testing.T) {
	t1, t2 := uuid.New(), uuid.New()

	first, second := seedUUID(t1, "a"), seedUUID(t1, "a")
	if first != second {
		t.Error("same tenant + label must yield the same id every time")
	}
	if seedUUID(t1, "a") == seedUUID(t1, "b") {
		t.Error("different labels for the same tenant must yield different ids")
	}
	if seedUUID(t1, "a") == seedUUID(t2, "a") {
		t.Error("the same label for different tenants must yield different ids")
	}
}
