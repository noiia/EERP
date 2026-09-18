package warehouse

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func init() {
	module.RegisterGoModule(&warehouseModule{})
}

// Product is the sellable catalog entry: name, unit of measure, and the
// price/tax pair a sale line snapshots from ("unit price free taxes" +
// "the tax from the product" in sale.SaleLine's doc comment). It is never
// referenced directly by a sale line — see ProductVariant.
// json tags mirror the db tags exactly: Echo's default Bind uses
// encoding/json, which without an explicit `json` tag matches a JSON key to
// a Go field name case-insensitively but NOT underscore-insensitively — a
// snake_case key like "unit_price" never matches field UnitPrice on its own
// (see warehouse/handler.go's Create, which c.Bind()s straight onto this
// struct). Every field a dedicated handler binds from client JSON needs one.
type Product struct {
	model.BaseModel
	Name string `db:"name" json:"name"`
	// Reference is a free-text SKU/internal code — optional, no uniqueness
	// enforced (this ORM has no unique-constraint support yet).
	Reference string `db:"reference" json:"reference"`
	// Unit is the unit of measure (e.g. "pcs", "kg", "hour") — free text
	// rather than a selection, since the set of units a business needs is
	// open-ended.
	Unit string `db:"unit" json:"unit"`
	// UnitPrice is the price excl. tax ("free taxes" in the request).
	UnitPrice float64 `db:"unit_price" json:"unit_price"`
	// TaxRate is a 0..1 ratio (percent widget on the frontend), same
	// contract as sale.Invoice's former single invoice-level TaxRate — here
	// it lives per product, since sale.Invoice.TaxAmount is now the sum of
	// each line's own product tax.
	TaxRate float64 `db:"tax_rate" json:"tax_rate"`
}

// ProductVariant is a concrete, sellable instance of a Product — the entity
// sale.SaleLine's first column actually points to (see sale/module.go). It
// only ever exists off an already-existing Product (ProductID is required,
// not a pointer): "a variant can be created only based on an existing
// product.product." A Product may have zero variants until one is needed;
// once created, it stays around and is reused for every later sale line on
// that product ("once one is created, the original stays referenced, and
// the variant exists") — see warehouse/handler.go for the auto-naming that
// makes creating one from a product a one-field action.
type ProductVariant struct {
	model.BaseModel
	ProductID uuid.UUID `db:"product_id" json:"product_id"`
	// Name is the variant's own label (e.g. "Red / XL"). Left blank on
	// create, it defaults to the underlying Product's name — see
	// warehouse/handler.go's Create override.
	Name string `db:"name" json:"name"`
	// UnitPrice, when set, overrides the parent Product's price for this one
	// variant (e.g. "Red / XL" costs more than "Red / S") — nil means
	// "inherit the product's price," the previous, only behavior. sale's
	// snapshotFromVariant (handler.go and quote_handler.go) prefers this over
	// Product.UnitPrice when present.
	UnitPrice *float64 `db:"unit_price" json:"unit_price"`
	// TaxRate, when set, overrides the parent Product's tax rate for this one
	// variant — same "nil means inherit" contract as UnitPrice above. sale's
	// snapshotFromVariant (handler.go and quote_handler.go) prefers this over
	// Product.TaxRate when present, so a sale line's tax percent is always
	// resolved from the specific variant sold, not just its product.
	TaxRate *float64 `db:"tax_rate" json:"tax_rate"`
}

// ProductUoms is the unit-of-measure catalog other modules' many2one fields
// pick from (e.g. propertymanagement.PropertyManagement.UomID, for
// FloorArea). Type is a closed set (see product_uoms_views.ts's `selection`)
// a picker filters on: "piece", "length", "weight", "volume", "surface", or
// "custom" for anything a tenant defines itself. Every tenant starts with
// defaultUoms already seeded (seedDefaultUoms, below) rather than an empty
// table.
type ProductUoms struct {
	model.BaseModel
	Name string `db:"name" json:"name"`
	Type string `db:"type" json:"type"`
	// Symbol is the short printable unit symbol ("m²", "ft²", "kg", ...) —
	// what a REPORT prints next to a value (propertymanagement's rent
	// receipt: `<floor_area> <symbol>`), as opposed to Name, which is the
	// picker's own human-readable label ("Square meter (m²)"). Free text,
	// no uniqueness constraint — a tenant can leave it blank for a custom
	// UOM with no conventional symbol.
	Symbol string `db:"symbol" json:"symbol"`
}

type warehouseModule struct{}

func (m *warehouseModule) Name() string { return "warehouse" }

func (m *warehouseModule) Register() error {
	if err := orm.Register[Product](); err != nil {
		return err
	}
	if err := orm.Register[ProductVariant](); err != nil {
		return err
	}
	return orm.Register[ProductUoms]()
}

// defaultUoms is the starter catalog every tenant is seeded with — enough of
// the metric and imperial systems to cover piece/length/weight/volume/
// surface out of the box (e.g. propertymanagement's FloorArea unit picker),
// so a fresh product_uoms table isn't empty. Not exhaustive — a tenant can
// always add its own via product_uoms' own quick-create wizard
// (product_uoms_views.ts, whose `type` options this list must keep matching).
var defaultUoms = []struct{ name, kind, symbol string }{
	{"Unit", "piece", "u"},

	{"Meter (m)", "length", "m"},
	{"Centimeter (cm)", "length", "cm"},
	{"Millimeter (mm)", "length", "mm"},
	{"Kilometer (km)", "length", "km"},
	{"Foot (ft)", "length", "ft"},
	{"Inch (in)", "length", "in"},
	{"Yard (yd)", "length", "yd"},
	{"Mile (mi)", "length", "mi"},

	{"Kilogram (kg)", "weight", "kg"},
	{"Gram (g)", "weight", "g"},
	{"Tonne (t)", "weight", "t"},
	{"Pound (lb)", "weight", "lb"},
	{"Ounce (oz)", "weight", "oz"},

	{"Liter (L)", "volume", "L"},
	{"Milliliter (mL)", "volume", "mL"},
	{"Cubic meter (m³)", "volume", "m³"},
	{"Gallon (gal)", "volume", "gal"},
	{"Fluid ounce (fl oz)", "volume", "fl oz"},

	// DefaultSurfaceUomName(Metric|Imperial) below name these two exact
	// entries — propertymanagement's own Create override looks them up BY
	// NAME (scoped to tenant + type=surface) to pick floor_area's default
	// uom_id from the workspace's units.system setting. Renaming either
	// breaks that lookup silently (it just falls back to no default) — keep
	// them in sync if either ever changes.
	{"Square meter (m²)", "surface", "m²"},
	{"Square centimeter (cm²)", "surface", "cm²"},
	{"Hectare (ha)", "surface", "ha"},
	{"Square foot (sqft)", "surface", "ft²"},
	{"Acre (ac)", "surface", "ac"},
}

// DefaultSurfaceUomNameMetric/DefaultSurfaceUomNameImperial name the exact
// defaultUoms row propertymanagement's own Create override (handler.go)
// looks up by (tenant, type=surface, name) to default a new property's
// floor_area uom_id from the workspace's units.system setting — exported so
// that module can resolve the SAME two rows without duplicating this list or
// depending on warehouse's own internal seeding order.
const (
	DefaultSurfaceUomNameMetric   = "Square meter (m²)"
	DefaultSurfaceUomNameImperial = "Square foot (sqft)"
)

// seedUUID derives a stable, reproducible v5 UUID from a tenant + a fixed
// label, so re-seeding the same tenant is idempotent via plain
// Repository.Upsert(id, "") — ON CONFLICT (id) DO NOTHING. Mirrors
// core/internal/auth/seed.go's own helper of the same name and shape,
// duplicated rather than imported: auth's is unexported, and this needs no
// other symbol from that package.
func seedUUID(tenantID uuid.UUID, label string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(tenantID.String()+":"+label))
}

// seedDefaultUoms idempotently seeds defaultUoms for every tenant that
// already has at least one user — this codebase has no tenants table to
// enumerate directly, so "every distinct tenant_id on a table guaranteed to
// have one row per real tenant" is the same idiom
// core/internal/company.Repository.BackfillCompanyID already uses (raw SQL:
// table is a fixed constant here, never user input).
//
// ponytail: a tenant created AFTER this Migrate() runs won't be seeded until
// the next full boot — there's no self-serve tenant-provisioning flow in
// this codebase yet to hook into (the same accepted gap
// core/internal/auth/seed.go's SeedDefaultRoles doc comment already notes).
// Upgrade path: call seedDefaultUoms from whatever "create tenant" flow
// eventually ships.
func seedDefaultUoms(ctx context.Context, db *orm.DB) error {
	rows, err := db.Query(ctx, `SELECT DISTINCT tenant_id FROM users`)
	if err != nil {
		return fmt.Errorf("warehouse: find tenants to seed default uoms: %w", err)
	}
	var tenantIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("warehouse: scan tenant id: %w", err)
		}
		tenantIDs = append(tenantIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("warehouse: iterate tenants: %w", err)
	}

	uoms := orm.MustRepo[ProductUoms](db)
	for _, tenantID := range tenantIDs {
		for _, u := range defaultUoms {
			row := ProductUoms{
				BaseModel: model.BaseModel{ID: seedUUID(tenantID, "product_uoms:"+u.name), TenantID: tenantID},
				Name:      u.name,
				Type:      u.kind,
				Symbol:    u.symbol,
			}
			// symbol = EXCLUDED.symbol (not the usual "" empty-fragment
			// DO NOTHING) so an existing deployment seeded before Symbol
			// existed gets backfilled on the next boot — safe: the ON
			// CONFLICT target is this row's own deterministic seed id, so it
			// can only ever touch a defaultUoms row, never a tenant's own
			// custom UOM (a real, random id).
			if _, err := uoms.Upsert(ctx, row, []string{"id"}, "symbol = EXCLUDED.symbol"); err != nil {
				return fmt.Errorf("warehouse: seed default uom %q: %w", u.name, err)
			}
		}
	}
	return nil
}

// Migrate implements module.Migrator — called once at boot, after Register()
// and the struct-derived table auto-migration, same as any other module's DDL
// step (core/internal/module/go_module.go's loadGoModule).
func (m *warehouseModule) Migrate(ctx context.Context, db *orm.DB) error {
	return seedDefaultUoms(ctx, db)
}
