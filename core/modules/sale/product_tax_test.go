package sale

import (
	"context"
	"testing"

	"core/internal/testdb"

	"github.com/google/uuid"
)

// The products' former tax_rate becomes product_tax links (to an existing
// tax of that rate, else a new "VAT n%"), once: the column is zeroed, so a
// second run — or a tax removed later — changes nothing.
func TestMigrateProductTaxRates(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "warehouse", "sale")
	var legacy bool
	must(t, app.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'product' AND column_name = 'tax_rate')`).Scan(&legacy))
	if !legacy {
		t.Skip("this database never had product.tax_rate")
	}
	tenant := uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{"product_tax", "sale_tax", "product"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	var existing uuid.UUID
	must(t, app.DB.QueryRow(ctx, `INSERT INTO sale_tax (tenant_id, name, kind, rate, amount) VALUES ($1, 'Standard', 'percentage', 0.2, 0) RETURNING id`,
		tenant).Scan(&existing))
	product := func(rate float64) uuid.UUID {
		var id uuid.UUID
		must(t, app.DB.QueryRow(ctx, `INSERT INTO product (tenant_id, name, tax_rate) VALUES ($1, 'p', $2) RETURNING id`, tenant, rate).Scan(&id))
		return id
	}
	p20, p55, p0 := product(0.2), product(0.055), product(0)

	for range 2 { // idempotent
		must(t, migrateProductTaxRates(ctx, app.DB))
	}

	taxOf := func(p uuid.UUID) (names []string) {
		rows, err := app.DB.Query(ctx, `SELECT t.name FROM product_tax pt JOIN sale_tax t ON t.id = pt.sale_tax_id
			WHERE pt.product_id = $1 AND pt.deleted_at IS NULL`, p)
		must(t, err)
		defer rows.Close()
		for rows.Next() {
			var n string
			must(t, rows.Scan(&n))
			names = append(names, n)
		}
		return names
	}
	if got := taxOf(p20); len(got) != 1 || got[0] != "Standard" {
		t.Errorf("20%% product taxes = %v, want the existing Standard tax", got)
	}
	if got := taxOf(p55); len(got) != 1 || got[0] != "VAT 5.5%" {
		t.Errorf("5.5%% product taxes = %v, want a new VAT 5.5%%", got)
	}
	if got := taxOf(p0); len(got) != 0 {
		t.Errorf("untaxed product taxes = %v, want none", got)
	}
	var left int
	must(t, app.DB.QueryRow(ctx, `SELECT count(*) FROM product WHERE tenant_id = $1 AND tax_rate <> 0`, tenant).Scan(&left))
	if left != 0 {
		t.Errorf("%d products kept a tax_rate", left)
	}
}
