package warehouse

import (
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
type Product struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name"`
	// Reference is a free-text SKU/internal code — optional, no uniqueness
	// enforced (this ORM has no unique-constraint support yet).
	Reference string `db:"reference"`
	// Unit is the unit of measure (e.g. "pcs", "kg", "hour") — free text
	// rather than a selection, since the set of units a business needs is
	// open-ended.
	Unit string `db:"unit"`
	// UnitPrice is the price excl. tax ("free taxes" in the request).
	UnitPrice float64 `db:"unit_price"`
	// TaxRate is a 0..1 ratio (percent widget on the frontend), same
	// contract as sale.Invoice's former single invoice-level TaxRate — here
	// it lives per product, since sale.Invoice.TaxAmount is now the sum of
	// each line's own product tax.
	TaxRate float64 `db:"tax_rate"`
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
	TenantID  uuid.UUID `db:"tenant_id"`
	ProductID uuid.UUID `db:"product_id"`
	// Name is the variant's own label (e.g. "Red / XL"). Left blank on
	// create, it defaults to the underlying Product's name — see
	// warehouse/handler.go's Create override.
	Name string `db:"name"`
}

type warehouseModule struct{}

func (m *warehouseModule) Name() string { return "warehouse" }

func (m *warehouseModule) Register() error {
	if err := orm.Register[Product](); err != nil {
		return err
	}
	return orm.Register[ProductVariant]()
}
