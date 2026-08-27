// Package propertymanagement lets users list and follow their real estate
// assets: a Property (name, address, current tenants, floor area), its
// Equipment (with a damage-state history and its own photos), and a
// monthly rent-receipt workflow (see handler.go's Generate flow, driven by
// the sale module's Confirm/Send/Accept/Decline header-button precedent).
//
// Table name derives from the Go struct name (core/CLAUDE.md's ORM section)
// — "propertymanagement" is the module FOLDER/package name only (the
// scaffolding tool's name regex forbids underscores there), independent of
// the struct names below, which is what actually produces the requested
// `property_management`/`property_management_equipment`/... table names.
package propertymanagement

import (
	"context"
	"fmt"
	"time"

	"core/internal/module"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func init() {
	module.RegisterGoModule(&propertyManagementModule{})
}

// PropertyManagement is one real estate asset. Address is the type:
// 'address' composite field (core-front's AddressWidget) — 7 real sibling
// columns, never a JSON blob, so they stay filterable/searchable through
// the generic list endpoint (docs/CLAUDE.md's FIELD_WIDGETS doc comment).
type PropertyManagement struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id" json:"tenant_id"`
	Name     string    `db:"name" json:"name"`
	// Address* — the type: 'address' composite field's 7 sibling columns,
	// prefixed "address_" to match the frontend field name 'address'.
	AddressNumber     *int   `db:"address_number" json:"address_number"`
	AddressComplement string `db:"address_complement" json:"address_complement"`
	AddressStreet     string `db:"address_street" json:"address_street"`
	AddressZipCode    string `db:"address_zip_code" json:"address_zip_code"`
	AddressCity       string `db:"address_city" json:"address_city"`
	AddressState      string `db:"address_state" json:"address_state"`
	AddressCountry    string `db:"address_country" json:"address_country"`
	// FloorArea is in the workspace's own unit (m²/sqft — free-form like
	// warehouse.Product.Unit, this module has no opinion).
	FloorArea float64 `db:"floor_area" json:"floor_area"`
	// LastReceiptMonth is "2026-08"-shaped, set by the Generate Rent Receipt
	// header button's handler (PropertyManagementViews.ts's
	// propertymanagement.generateRentReceipt) — what the Property GET
	// override (handler.go) compares against the current month to compute
	// the non-stored receipt_generated_this_month key the header button's
	// states.readOnly condition checks (see core-front/CLAUDE.md's Header
	// button container row). A pointer: nil (never generated) must be a
	// valid CREATE-time value — a plain string would make the generic CRUD
	// layer's required-on-create check (core/orm/internal/crud.ValidateRequest)
	// demand it in every POST body, even though nothing before the first
	// Generate click ever has a month to report.
	LastReceiptMonth *string `db:"last_receipt_month" json:"last_receipt_month"`
}

// PropertyManagementTenant is the many2many junction behind Property's
// current_tenant field — owned entirely by this module (no schema change to
// the existing contact module, per the user's own confirmed choice: several
// tenants per property, no outbound FK added to Contact).
type PropertyManagementTenant struct {
	model.BaseModel
	TenantID             uuid.UUID `db:"tenant_id" json:"tenant_id"`
	PropertyManagementID uuid.UUID `db:"property_management_id" json:"property_management_id"`
	ContactID            uuid.UUID `db:"contact_id" json:"contact_id"`
}

// PropertyManagementPhoto is one row of a Property's Photos page (relation/
// carousel, core-front's carousel-widget.tsx) — Position orders the
// carousel; the actual bytes live on the core picture service, anchored at
// (tenant, 'property_management_photo', id, 'picture') — no extra column or
// backend work needed for that half, pictures is entity-agnostic already.
type PropertyManagementPhoto struct {
	model.BaseModel
	TenantID             uuid.UUID `db:"tenant_id" json:"tenant_id"`
	PropertyManagementID uuid.UUID `db:"property_management_id" json:"property_management_id"`
	Position             int       `db:"position" json:"position"`
}

// PropertyManagementEquipment is one piece of equipment, owned by EXACTLY
// one property (the user's own confirmed choice — not shared/movable, a
// real FK same shape as sale_line belonging to one invoice).
type PropertyManagementEquipment struct {
	model.BaseModel
	TenantID             uuid.UUID `db:"tenant_id" json:"tenant_id"`
	PropertyManagementID uuid.UUID `db:"property_management_id" json:"property_management_id"`
	Name                 string    `db:"name" json:"name"`
	Quantity             int       `db:"quantity" json:"quantity"`
	// CurrentState is a ROLLUP of the latest PropertyManagementEquipmentStatus
	// row (by Date), recomputed server-side whenever a status entry is
	// created (handler.go's Create override) — the SAME "child row changes,
	// parent rollup recomputes" shape sale.recomputeTotals already
	// established for invoice totals. Never hand-typed.
	CurrentState string `db:"current_state" json:"current_state"`
	// BillingOfBuy is the boolean/file flag (internal/attachments) for the
	// purchase invoice/receipt — field true ⇔ an attachment exists on this
	// record's billing_of_buy anchor.
	BillingOfBuy bool       `db:"billing_of_buy" json:"billing_of_buy"`
	BuyingPrice  float64    `db:"buying_price" json:"buying_price"`
	BuyingDate   *time.Time `db:"buying_date" json:"buying_date"`
}

// PropertyManagementEquipmentStatus is one dated entry in an equipment's
// damage-state history (the user's own confirmed choice: a log, not a
// single current-status field) — State is a closed vocabulary, same
// selection-field shape as sale.Invoice.Status.
type PropertyManagementEquipmentStatus struct {
	model.BaseModel
	TenantID                      uuid.UUID  `db:"tenant_id" json:"tenant_id"`
	PropertyManagementEquipmentID uuid.UUID  `db:"property_management_equipment_id" json:"property_management_equipment_id"`
	Date                          *time.Time `db:"date" json:"date"`
	// State: "good", "damaged", "under_repair", "out_of_service".
	State string `db:"state" json:"state"`
}

// PropertyManagementEquipmentPhoto mirrors PropertyManagementPhoto exactly,
// scoped to equipment instead of the property itself.
type PropertyManagementEquipmentPhoto struct {
	model.BaseModel
	TenantID                      uuid.UUID `db:"tenant_id" json:"tenant_id"`
	PropertyManagementEquipmentID uuid.UUID `db:"property_management_equipment_id" json:"property_management_equipment_id"`
	Position                      int       `db:"position" json:"position"`
}

// PropertyManagementRentReceipt is one generated rent receipt — APPEND-ONLY
// (handler.go hand-mounts Update/Delete to always reject, a real backend
// guarantee mirroring internal/chatter's own append-only posture, not just a
// hidden UI control). Snapshots what the PDF needs to show at generation
// time — same "capture at document time, don't live-join" discipline
// sale.SaleLine/Invoice already follow, since a receipt must keep reading
// correctly even if the property/tenants are edited afterward.
//
// One generation click produces a PARENT row (one per property+period,
// PropertyManagementID set, ParentID nil, no PDF of its own — TenantNames
// holds the full comma-joined list, for display only) plus one CHILD row
// per current tenant (ParentID set to the parent's id, PropertyManagementID
// left nil, TenantNames holds that ONE tenant's name, ReceiptFile its own
// dedicated PDF) — self-referencing, the same shape TreeRenderer already
// expects for a hierarchical tree view (any row with parent_id != null).
// The property form's own rent_receipts field (PropertyManagementViews.ts,
// inverseField: property_management_id) therefore lists PARENTS only —
// children never match that filter, since they carry no
// property_management_id — and a parent's own read-only form embeds its
// children through a SECOND relation field (inverseField: parent_id).
type PropertyManagementRentReceipt struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id" json:"tenant_id"`
	// PropertyManagementID: set on a parent row, nil on a child (see the
	// type doc comment above). A pointer for the same reason
	// LastReceiptMonth is: a child's Create body omits it entirely.
	PropertyManagementID *uuid.UUID `db:"property_management_id" json:"property_management_id"`
	// ParentID: nil on a parent row, set to that parent's id on a child.
	ParentID *uuid.UUID `db:"parent_id" json:"parent_id"`
	// IsParent: true on a parent row, false on a child. Exists ONLY because
	// the generic list endpoint's filter[col]= is an exact-match compare —
	// there is no "column IS NULL" filter to scope the flat, cross-property
	// receipts list (PropertyManagementViews.ts's rentReceiptListView) to
	// parents by ParentID alone; this plain boolean is filterable the normal
	// way (filter[is_parent]=true).
	IsParent bool `db:"is_parent" json:"is_parent"`
	// Period is "2026-08"-shaped — the calendar month this receipt covers.
	Period       string     `db:"period" json:"period"`
	GeneratedAt  *time.Time `db:"generated_at" json:"generated_at"`
	PropertyName string     `db:"property_name" json:"property_name"`
	// PropertyAddress is the FULL formatted line (number/street, complement,
	// zip/city, country — PropertyManagementViews.ts's formatPropertyAddress)
	// snapshotted at generation time, not just number+street.
	PropertyAddress string `db:"property_address" json:"property_address"`
	// FloorArea snapshots PropertyManagement.FloorArea at generation time —
	// the printed report's own "Property management form content" the user
	// asked for, beyond the address.
	FloorArea   float64 `db:"floor_area" json:"floor_area"`
	TenantNames string  `db:"tenant_names" json:"tenant_names"`
	// ReceiptFile is the boolean/file flag (internal/attachments) for the
	// SAVED PDF — a fixed snapshot from generation time, never recomputed
	// live on later downloads (the user's own explicit requirement). Always
	// false on a parent row: no PDF is ever generated for it.
	ReceiptFile bool `db:"receipt_file" json:"receipt_file"`
}

type propertyManagementModule struct{}

func (m *propertyManagementModule) Name() string { return "propertymanagement" }

func (m *propertyManagementModule) Register() error {
	if err := orm.Register[PropertyManagement](); err != nil {
		return err
	}
	if err := orm.Register[PropertyManagementTenant](); err != nil {
		return err
	}
	if err := orm.Register[PropertyManagementPhoto](); err != nil {
		return err
	}
	if err := orm.Register[PropertyManagementEquipment](); err != nil {
		return err
	}
	if err := orm.Register[PropertyManagementEquipmentStatus](); err != nil {
		return err
	}
	if err := orm.Register[PropertyManagementEquipmentPhoto](); err != nil {
		return err
	}
	return orm.Register[PropertyManagementRentReceipt]()
}

// Migrate runs AFTER auto-migration's ADD COLUMN pass (internal/module's
// Registry.Load — a Migrator hook, same pattern as core/modules/company's
// own Migrate). Needed because LastReceiptMonth changed from a plain string
// to a *string (2026-08): auto-migration's ADD COLUMN IF NOT EXISTS is
// purely additive, so a deployment that already had this table keeps the
// column's ORIGINAL NOT NULL from before that change — DROP NOT NULL is
// what actually lets a freshly-created property (which has no receipt month
// yet) omit the column. A no-op on a database that never had the old
// constraint (a fresh DB already creates it nullable).
func (m *propertyManagementModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		ALTER TABLE property_management ALTER COLUMN last_receipt_month DROP NOT NULL
	`); err != nil {
		return fmt.Errorf("propertymanagement: drop last_receipt_month NOT NULL: %w", err)
	}
	// Same reasoning, for PropertyManagementRentReceipt.PropertyManagementID's
	// 2026-08 change from uuid.UUID to *uuid.UUID (parent/child rent
	// receipts, above): a deployment that already had this table keeps the
	// column's original NOT NULL, which would reject every child row's
	// Create (it deliberately omits property_management_id).
	if _, err := db.Exec(ctx, `
		ALTER TABLE property_management_rent_receipt ALTER COLUMN property_management_id DROP NOT NULL
	`); err != nil {
		return fmt.Errorf("propertymanagement: drop rent receipt property_management_id NOT NULL: %w", err)
	}
	return nil
}
