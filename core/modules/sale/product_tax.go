package sale

import (
	"context"
	"fmt"

	"core/modules/warehouse"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// A product's taxes: the same SaleTax catalog (and the same tags widget) a
// sale line, a quote line or a property billing line uses — linked through
// product_tax. The sale module owns it (it owns the tax catalog; warehouse,
// which sale depends on, can't know sale_tax), and adds the Taxes field to
// warehouse's product form by a view extension (sale_views.ts).
//
// A line created from a variant inherits its product's taxes: an invoice line
// gets one sale_line_tax link per product tax; a quote line (no tax links of
// its own) folds the product's percentage taxes into its tax_rate. Either way
// a variant's own tax_rate, when set, adds on top.

// ProductTax links a product to one of its taxes — generic CRUD (the form's
// tags widget writes it), unique (product, tax) index hand-written in Migrate.
type ProductTax struct {
	model.BaseModel
	ProductID uuid.UUID `db:"product_id,index" json:"product_id"`
	SaleTaxID uuid.UUID `db:"sale_tax_id" json:"sale_tax_id"`
}

// productTaxes resolves a product's taxes, within the tenant.
func productTaxes(ctx context.Context, links *orm.Repository[ProductTax], taxes *orm.Repository[SaleTax], tenant, productID uuid.UUID) ([]SaleTax, error) {
	rows, err := links.FindAll(ctx, orm.Cond("product_id = $1 AND tenant_id = $2", productID, tenant))
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, l := range rows {
		ids[i] = l.SaleTaxID
	}
	return ResolveTaxes(ctx, taxes, tenant, ids)
}

// variantRate is a variant's own extra tax rate (0 when it has none).
func variantRate(v warehouse.ProductVariant) float64 {
	if v.TaxRate != nil {
		return *v.TaxRate
	}
	return 0
}

// percentageRate sums the percentage taxes (fixed amounts can't be a rate).
func percentageRate(taxes []SaleTax) float64 {
	var rate float64
	for _, t := range taxes {
		if t.Kind != "fixed" {
			rate += t.Rate
		}
	}
	return rate
}

// linkLineTaxes gives an invoice line one sale_line_tax link per tax.
func linkLineTaxes(ctx context.Context, repo *orm.Repository[SaleLineTax], tenant, lineID uuid.UUID, taxes []SaleTax) error {
	for _, t := range taxes {
		link := SaleLineTax{SaleLineID: lineID, SaleTaxID: t.ID,
			TenantID: tenant}
		if _, err := repo.Create(ctx, link); err != nil {
			return fmt.Errorf("sale: link line tax: %w", err)
		}
	}
	return nil
}

// migrateProductTaxRates turns the products' former single tax_rate into
// product_tax links — to a percentage tax of that rate, created ("VAT n%")
// when the tenant has none — then zeroes the old column, so it runs once per
// product and a tax the user later removes never comes back. Set-based and
// idempotent; a database created after the column left the model has none,
// and nothing to convert.
func migrateProductTaxRates(ctx context.Context, db *orm.DB) error {
	var legacy bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'product' AND column_name = 'tax_rate')`).Scan(&legacy); err != nil {
		return fmt.Errorf("sale: look for product.tax_rate: %w", err)
	}
	if !legacy {
		return nil
	}
	return orm.Transact(ctx, db, func(tx *orm.Tx) error {
		for _, stmt := range []string{
			`INSERT INTO sale_tax (tenant_id, name, kind, rate, amount)
			 SELECT DISTINCT p.tenant_id, 'VAT ' || trim(trailing '.' from trim(trailing '0' from to_char(p.tax_rate * 100, 'FM990.999'))) || '%',
			        'percentage', p.tax_rate, 0
			   FROM product p
			  WHERE p.tax_rate > 0 AND p.deleted_at IS NULL
			    AND NOT EXISTS (SELECT 1 FROM sale_tax t WHERE t.tenant_id = p.tenant_id AND t.kind = 'percentage'
			                      AND t.rate = p.tax_rate AND t.deleted_at IS NULL)`,
			`INSERT INTO product_tax (tenant_id, product_id, sale_tax_id)
			 SELECT p.tenant_id, p.id,
			        (SELECT t.id FROM sale_tax t WHERE t.tenant_id = p.tenant_id AND t.kind = 'percentage'
			           AND t.rate = p.tax_rate AND t.deleted_at IS NULL ORDER BY t.created_at, t.id LIMIT 1)
			   FROM product p
			  WHERE p.tax_rate > 0 AND p.deleted_at IS NULL
			    AND NOT EXISTS (SELECT 1 FROM product_tax pt WHERE pt.product_id = p.id AND pt.deleted_at IS NULL)`,
			`UPDATE product SET tax_rate = 0 WHERE tax_rate <> 0`,
		} {
			if _, err := tx.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("sale: migrate product tax rates: %w", err)
			}
		}
		return nil
	})
}
