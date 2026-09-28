package devseed_test

import (
	"context"
	"errors"
	"math"
	"testing"

	"core/internal/devseed"
	"core/internal/testdb"

	_ "core/modules/auth"
	_ "core/modules/company"
	_ "core/modules/contact"
	_ "core/modules/crm"
	_ "core/modules/graphfield"
	_ "core/modules/propertymanagement"
	_ "core/modules/sale"
	_ "core/modules/settings"
	_ "core/modules/warehouse"

	"github.com/google/uuid"
)

var seededTables = []string{
	"property_management_rent_receipt_line", "property_management_rent_receipt", "property_management",
	"sale_line_tax", "sale_line", "invoice", "quote_line", "quote", "crm_tag", "tag", "crm", "contact",
	"product_variant", "product", "sale_tax", "graph_field", "app_settings", "company",
}

// TestSeed runs the full-volume seed just over the graph threshold into a
// fresh tenant and checks counts, money consistency, the seeded graphs, and
// that a second run is refused.
func TestSeed(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "graphfield", "contact", "crm", "warehouse", "sale", "propertymanagement")
	ctx := context.Background()
	tenant := uuid.New()
	t.Cleanup(func() {
		for _, table := range seededTables {
			_, _ = app.DB.Exec(ctx, "DELETE FROM "+table+" WHERE tenant_id = $1", tenant)
		}
	})
	// A default company, as every real tenant has one.
	if _, err := app.DB.Exec(ctx, "INSERT INTO company (tenant_id, name, currency, is_default) VALUES ($1, 'Home', 'EUR', true)", tenant); err != nil {
		t.Fatal(err)
	}

	n := devseed.GraphThreshold + 1
	results, err := devseed.Seed(ctx, app.DB, tenant, n)
	if err != nil {
		t.Fatal(err)
	}
	created := map[string]int64{}
	for _, r := range results {
		created[r.Entity] = r.Created
	}
	for entity, want := range map[string]int64{
		"company": 3, "sale_tax": 6, "product": int64(n), "product_variant": int64(n), "contact": int64(n), "crm": int64(n),
		"crm_tag": int64(n), "quote": int64(n), "quote_line": 2 * int64(n), "invoice": int64(n), "sale_line": 2 * int64(n),
		"property_management": int64(n / 100), "property_management_rent_receipt": int64(n), "property_management_rent_receipt_line": int64(n),
		"graph view: invoice": 8, "graph view: contact": 4,
	} {
		if created[entity] != want {
			t.Errorf("%s: created %d, want %d", entity, created[entity], want)
		}
	}
	if created["sale_line_tax"] == 0 {
		t.Error("expected some sale lines to carry extra tax tags")
	}

	one := func(sql string) float64 {
		t.Helper()
		var v float64
		if err := app.DB.QueryRow(ctx, sql, tenant).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	// Invoice totals are the sum of their lines; a tagged line's total stacks
	// its VAT, percentage tags and fixed amounts like sale.computeLineTotal.
	if d := one(`SELECT coalesce(max(abs(i.total - s.tot)), 0) FROM invoice i
		JOIN (SELECT invoice_id, sum(total) tot FROM sale_line WHERE tenant_id = $1 GROUP BY invoice_id) s ON s.invoice_id = i.id`); d > 0.01 {
		t.Errorf("invoice total differs from its lines by %v", d)
	}
	if d := one(`SELECT coalesce(max(abs(l.total - round((l.subtotal * (1 + l.tax_rate + x.rate) + x.fixed)::numeric, 2))), 0)
		FROM sale_line l JOIN (SELECT slt.sale_line_id,
			sum(CASE WHEN t.kind = 'fixed' THEN 0 ELSE t.rate END) rate, sum(CASE WHEN t.kind = 'fixed' THEN t.amount ELSE 0 END) fixed
			FROM sale_line_tax slt JOIN sale_tax t ON t.id = slt.sale_tax_id WHERE slt.tenant_id = $1 GROUP BY 1) x ON x.sale_line_id = l.id`); d > 0.01 {
		t.Errorf("tagged line total off by %v", d)
	}
	if d := one(`SELECT coalesce(max(abs(total - subtotal - tax_amount)), 0) FROM quote WHERE tenant_id = $1`); d > 0.01 {
		t.Errorf("quote total != subtotal + tax (off by %v)", d)
	}
	// Graphs land in every company (1 default + 3 seeded) for all 7 entities.
	if got := one(`SELECT count(*) FROM app_settings WHERE tenant_id = $1 AND key LIKE 'views.%.graph'`); got != 4*7 {
		t.Errorf("graph layouts = %v, want 28", got)
	}
	if got := one(`SELECT count(*) FROM app_settings WHERE tenant_id = $1 AND key LIKE 'views.%.fields' AND value::jsonb->>'enable_graphs' = 'true'`); got != 4*7 {
		t.Errorf("graphs enabled = %v, want 28", got)
	}
	if got := one(`SELECT count(*) FROM graph_field WHERE tenant_id = $1`); got != 13 {
		t.Errorf("calculated fields = %v, want 13", got)
	}
	if got := one(`SELECT avg(total) FROM invoice WHERE tenant_id = $1`); got <= 0 || math.IsNaN(got) {
		t.Errorf("invoices have no totals: %v", got)
	}

	if _, err := devseed.Seed(ctx, app.DB, tenant, n); !errors.Is(err, devseed.ErrAlreadySeeded) {
		t.Fatalf("second run: %v, want ErrAlreadySeeded", err)
	}
}
