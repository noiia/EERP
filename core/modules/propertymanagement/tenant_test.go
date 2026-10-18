package propertymanagement

import (
	"context"
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/testdb"
	"core/modules/sale"
	"core/modules/warehouse"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// Every override in handler.go reads and writes through typed repositories,
// which — unlike the generic CRUD layer — don't scope by tenant. A caller
// aiming one at another workspace's row (an id in the path or the body) must
// get a 404 and leave that row untouched; its own rows keep working.
func TestOverrides_AreTenantScoped(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "settings", "sale", "propertymanagement")
	owner, intruder := uuid.New(), uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{
			"property_management_rent_receipt_line", "property_management_rent_receipt",
			"property_management_billing_line_tax", "property_management_billing_line",
			"property_management_equipment_status", "property_management_equipment",
			"property_management", "sale_tax", "app_settings",
		} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = ANY($1)`, []uuid.UUID{owner, intruder})
		}
	})

	h := NewHandler(
		orm.MustRepo[PropertyManagement](app.DB),
		orm.MustRepo[PropertyManagementEquipment](app.DB),
		orm.MustRepo[PropertyManagementEquipmentStatus](app.DB),
		orm.MustRepo[PropertyManagementBillingLine](app.DB),
		orm.MustRepo[PropertyManagementBillingLineTax](app.DB),
		orm.MustRepo[sale.SaleTax](app.DB),
		orm.MustRepo[PropertyManagementRentReceipt](app.DB),
		orm.MustRepo[PropertyManagementRentReceiptLine](app.DB),
		orm.MustRepo[warehouse.ProductUoms](app.DB),
		settings.NewRepository(app.DB),
		nil, // companies: only the tax price mode needs it, reached past the guards
	)
	in := func(tenant uuid.UUID) model.BaseModel { return model.BaseModel{TenantID: tenant} }
	property, err := h.properties.Create(ctx, PropertyManagement{BaseModel: in(owner), Name: "Owner's flat"})
	must(t, err)
	equipment, err := h.equipment.Create(ctx, PropertyManagementEquipment{
		BaseModel: in(owner), PropertyManagementID: property.ID, Name: "Boiler", CurrentState: "good",
	})
	must(t, err)
	line, err := h.billingLines.Create(ctx, PropertyManagementBillingLine{
		BaseModel: in(owner), PropertyManagementID: property.ID, Name: "Fees", UnitPrice: 100, Total: 100,
	})
	must(t, err)
	tax, err := h.taxes.Create(ctx, sale.SaleTax{BaseModel: in(owner), Name: "VAT", Kind: "percentage", Rate: 0.2})
	must(t, err)
	link, err := h.billingLineTaxes.Create(ctx, PropertyManagementBillingLineTax{
		BaseModel: in(owner), PropertyManagementBillingLineID: line.ID, SaleTaxID: tax.ID,
	})
	must(t, err)
	receipt, err := h.rentReceipts.Create(ctx, PropertyManagementRentReceipt{BaseModel: in(owner), Period: "2026-10", Total: 500})
	must(t, err)

	them := auth.Identity{TenantID: intruder, UserID: uuid.New()}
	tests := []struct {
		name   string
		call   func() int
		method string
	}{
		{"GET property", func() int {
			return serveSettings(t, h.GetProperty, http.MethodGet, "", them, property.ID.String()).Code
		}, http.MethodGet},
		{"GET rent receipt", func() int {
			return serveSettings(t, h.GetRentReceipt, http.MethodGet, "", them, receipt.ID.String()).Code
		}, http.MethodGet},
		{"PUT billing line", func() int {
			return serveSettings(t, h.UpdateBillingLine, http.MethodPut, `{"name":"Stolen","unit_price":1}`, them, line.ID.String()).Code
		}, http.MethodPut},
		{"DELETE billing line tax", func() int {
			return serveSettings(t, h.DeleteBillingLineTax, http.MethodDelete, "", them, link.ID.String()).Code
		}, http.MethodDelete},
		{"POST tax link onto their line", func() int {
			return serveSettings(t, h.CreateBillingLineTax, http.MethodPost,
				`{"property_management_billing_line_id":"`+line.ID.String()+`","sale_tax_id":"`+tax.ID.String()+`"}`, them, "").Code
		}, http.MethodPost},
		{"POST equipment status onto their equipment", func() int {
			return serveSettings(t, h.CreateEquipmentStatus, http.MethodPost,
				`{"property_management_equipment_id":"`+equipment.ID.String()+`","state":"broken"}`, them, "").Code
		}, http.MethodPost},
		{"POST receipt line onto their receipt", func() int {
			return serveSettings(t, h.CreateRentReceiptLine, http.MethodPost,
				`{"rent_receipt_id":"`+receipt.ID.String()+`","name":"Injected","unit_price":9999,"subtotal":9999,"total":9999}`, them, "").Code
		}, http.MethodPost},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code := tt.call(); code != http.StatusNotFound {
				t.Errorf("%s from another tenant = %d, want 404", tt.method, code)
			}
		})
	}

	// The owner's rows are exactly as they were.
	gotLine, err := findOwned(ctx, h.billingLines, line.ID, owner)
	must(t, err)
	if gotLine.TenantID != owner || gotLine.Name != "Fees" || gotLine.UnitPrice != 100 {
		t.Errorf("billing line changed: %+v", gotLine)
	}
	if _, err := findOwned(ctx, h.billingLineTaxes, link.ID, owner); err != nil {
		t.Errorf("tax link was deleted: %v", err)
	}
	gotEquipment, err := findOwned(ctx, h.equipment, equipment.ID, owner)
	must(t, err)
	if gotEquipment.CurrentState != "good" {
		t.Errorf("equipment state = %q, want good", gotEquipment.CurrentState)
	}
	gotReceipt, err := findOwned(ctx, h.rentReceipts, receipt.ID, owner)
	must(t, err)
	if gotReceipt.Total != 500 {
		t.Errorf("receipt total = %v, want 500", gotReceipt.Total)
	}
	var written int
	must(t, app.DB.QueryRow(ctx, `SELECT count(*) FROM property_management_equipment_status WHERE tenant_id = $1`, intruder).Scan(&written))
	var lines int
	must(t, app.DB.QueryRow(ctx, `SELECT count(*) FROM property_management_rent_receipt_line WHERE tenant_id = $1`, intruder).Scan(&lines))
	if written != 0 || lines != 0 {
		t.Errorf("rows written by the intruder: %d statuses, %d receipt lines", written, lines)
	}

	// The guard doesn't get in the owner's way.
	us := auth.Identity{TenantID: owner, UserID: uuid.New()}
	if code := serveSettings(t, h.GetProperty, http.MethodGet, "", us, property.ID.String()).Code; code != http.StatusOK {
		t.Errorf("owner GET property = %d, want 200", code)
	}
	if rec := serveSettings(t, h.CreateEquipmentStatus, http.MethodPost,
		`{"property_management_equipment_id":"`+equipment.ID.String()+`","state":"broken"}`, us, ""); rec.Code != http.StatusCreated {
		t.Fatalf("owner POST equipment status = %d %s", rec.Code, rec.Body.String())
	}
	gotEquipment, err = findOwned(ctx, h.equipment, equipment.ID, owner)
	must(t, err)
	if gotEquipment.CurrentState != "broken" {
		t.Errorf("owner's status didn't roll up: %q", gotEquipment.CurrentState)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
