package propertymanagement

import (
	"context"
	"fmt"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
)

// Development seed data — DEV ONLY, gated behind the same seed_dev_admin config flag as
// auth.SeedDevAdmin (main.go calls both together). It populates the module's full entity
// graph — a property with equipment (and a damage-state history), a tenant, and one
// generated rent receipt (parent + per-tenant child, the same shape the real Generate
// Rent Receipt header button produces) — so the module has something to look at right
// after `make run-back`, without needing the frontend's own Settings -> Developer seed
// (core-front/CLAUDE.md's dev-seed.ts, which only reaches contact/crm/product/sale/quote).
//
// Raw SQL rather than the ORM repositories, mirroring auth.SeedDevAdmin: it keeps this
// file free of any cross-module Go import for the tenant Contact row — Contact lives in
// contact's UNEXPORTED internal package (core/modules/contact/module.go), and unlike
// crm's own CRM type it has no exported alias re-exposing it (crm/model.go's own comment
// explains why an inheriting module needs that re-export at all). Every statement stays
// idempotent via a fixed id + ON CONFLICT DO NOTHING, safe to run on every startup.
var (
	demoContactID          = uuid.MustParse("000000d0-0000-0000-0000-000000000001")
	demoProperty1ID        = uuid.MustParse("000000d1-0000-0000-0000-000000000001")
	demoProperty2ID        = uuid.MustParse("000000d1-0000-0000-0000-000000000002")
	demoTenantLinkID       = uuid.MustParse("000000d2-0000-0000-0000-000000000001")
	demoEquipmentWaterID   = uuid.MustParse("000000d3-0000-0000-0000-000000000001")
	demoEquipmentFridgeID  = uuid.MustParse("000000d3-0000-0000-0000-000000000002")
	demoStatusWaterID      = uuid.MustParse("000000d4-0000-0000-0000-000000000001")
	demoStatusFridgeGoodID = uuid.MustParse("000000d4-0000-0000-0000-000000000002")
	demoStatusFridgeBadID  = uuid.MustParse("000000d4-0000-0000-0000-000000000003")
	demoRentParentID       = uuid.MustParse("000000d5-0000-0000-0000-000000000001")
	demoRentChildID        = uuid.MustParse("000000d5-0000-0000-0000-000000000002")
)

// SeedDemoData populates two demo properties: "Riverside Apartment" (a tenant, two
// pieces of equipment with a damage-state history, and a rent receipt already generated
// last period) and "Lakeside Cottage" (no tenant/equipment/receipt yet — the "nothing
// happened here so far" state a real workspace also starts most properties in).
func SeedDemoData(ctx context.Context, db *orm.DB) error {
	now := time.Now()
	waterBuyDate := now.AddDate(-1, -2, 0)
	fridgeBuyDate := now.AddDate(-2, 0, 0)
	fridgeBadDate := now.AddDate(0, -1, 0)
	lastPeriod := now.AddDate(0, -1, 0).Format("2006-01")
	generatedAt := now.AddDate(0, -1, 5)

	statements := []struct {
		sql  string
		args []any
	}{
		{
			`INSERT INTO contact (id, tenant_id, name, email, company, status, created_at, updated_at)
			 VALUES ($1, $2, 'Jean Dupont', 'jean.dupont@example.com', '', 'customer', NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoContactID, auth.DevTenantID},
		},
		{
			`INSERT INTO property_management
			 (id, tenant_id, name, address_number, address_complement, address_street, address_zip_code, address_city, address_state, address_country, floor_area, last_receipt_month, created_at, updated_at)
			 VALUES ($1, $2, 'Riverside Apartment', 45, '', 'Rue de la Paix', '75002', 'Paris', '', 'France', 68.5, $3, NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoProperty1ID, auth.DevTenantID, lastPeriod},
		},
		{
			`INSERT INTO property_management
			 (id, tenant_id, name, address_number, address_complement, address_street, address_zip_code, address_city, address_state, address_country, floor_area, last_receipt_month, created_at, updated_at)
			 VALUES ($1, $2, 'Lakeside Cottage', 12, '', 'Lake View Road', '74000', 'Annecy', '', 'France', 120, NULL, NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoProperty2ID, auth.DevTenantID},
		},
		{
			`INSERT INTO property_management_tenant (id, tenant_id, property_management_id, contact_id, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{demoTenantLinkID, auth.DevTenantID, demoProperty1ID, demoContactID},
		},
		{
			`INSERT INTO property_management_equipment
			 (id, tenant_id, property_management_id, name, quantity, current_state, billing_of_buy, buying_price, buying_date, created_at, updated_at)
			 VALUES ($1, $2, $3, 'Water Heater', 1, 'good', false, 450.00, $4, NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoEquipmentWaterID, auth.DevTenantID, demoProperty1ID, waterBuyDate},
		},
		{
			`INSERT INTO property_management_equipment
			 (id, tenant_id, property_management_id, name, quantity, current_state, billing_of_buy, buying_price, buying_date, created_at, updated_at)
			 VALUES ($1, $2, $3, 'Refrigerator', 1, 'damaged', false, 620.00, $4, NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoEquipmentFridgeID, auth.DevTenantID, demoProperty1ID, fridgeBuyDate},
		},
		{
			`INSERT INTO property_management_equipment_status (id, tenant_id, property_management_equipment_id, date, state, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'good', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{demoStatusWaterID, auth.DevTenantID, demoEquipmentWaterID, waterBuyDate},
		},
		{
			`INSERT INTO property_management_equipment_status (id, tenant_id, property_management_equipment_id, date, state, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'good', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{demoStatusFridgeGoodID, auth.DevTenantID, demoEquipmentFridgeID, fridgeBuyDate},
		},
		{
			`INSERT INTO property_management_equipment_status (id, tenant_id, property_management_equipment_id, date, state, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'damaged', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{demoStatusFridgeBadID, auth.DevTenantID, demoEquipmentFridgeID, fridgeBadDate},
		},
		{
			`INSERT INTO property_management_rent_receipt
			 (id, tenant_id, property_management_id, parent_id, is_parent, period, generated_at, property_name, property_address, floor_area, tenant_names, receipt_file, created_at, updated_at)
			 VALUES ($1, $2, $3, NULL, true, $4, $5, 'Riverside Apartment', '45 Rue de la Paix, 75002 Paris, France', 68.5, 'Jean Dupont', false, NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoRentParentID, auth.DevTenantID, demoProperty1ID, lastPeriod, generatedAt},
		},
		{
			`INSERT INTO property_management_rent_receipt
			 (id, tenant_id, property_management_id, parent_id, is_parent, period, generated_at, property_name, property_address, floor_area, tenant_names, receipt_file, created_at, updated_at)
			 VALUES ($1, $2, NULL, $3, false, $4, $5, 'Riverside Apartment', '45 Rue de la Paix, 75002 Paris, France', 68.5, 'Jean Dupont', false, NOW(), NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[]any{demoRentChildID, auth.DevTenantID, demoRentParentID, lastPeriod, generatedAt},
		},
	}

	for _, s := range statements {
		if _, err := db.Exec(ctx, s.sql, s.args...); err != nil {
			return fmt.Errorf("seed property management demo data: %w", err)
		}
	}
	return nil
}
