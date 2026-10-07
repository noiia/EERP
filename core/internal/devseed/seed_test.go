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
	_ "core/modules/event"
	_ "core/modules/graphfield"
	_ "core/modules/propertymanagement"
	_ "core/modules/sale"
	_ "core/modules/settings"
	_ "core/modules/warehouse"

	"github.com/google/uuid"
)

var seededTables = []string{
	"event_booking", "event_session", "event_availability", "event",
	"property_management_rent_receipt_line", "property_management_rent_receipt", "property_management",
	"sale_line_tax", "sale_line", "invoice", "quote_line", "quote", "crm_tag", "tag", "crm", "contact",
	"product_variant", "product", "sale_tax", "graph_field", "app_settings", "company",
}

// TestSeed runs the full-volume seed just over the graph threshold into a
// fresh tenant and checks counts, money consistency, the seeded graphs, and
// that a second run is refused.
func TestSeed(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "graphfield", "contact", "crm", "warehouse", "sale", "propertymanagement", "event")
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
	results, err := devseed.Seed(ctx, app.DB, tenant, n, nil)
	if err != nil {
		t.Fatal(err)
	}
	created := map[string]int64{}
	for _, r := range results {
		created[r.Entity] += r.Created // event_booking comes in two steps (sessions, slots)
	}
	for entity, want := range map[string]int64{
		"company": 3, "sale_tax": 6, "product": int64(n), "product_variant": int64(n), "contact": int64(n), "crm": int64(n),
		"crm_tag": int64(n), "quote": int64(n), "quote_line": 2 * int64(n), "invoice": int64(n), "sale_line": 2 * int64(n),
		"property_management": int64(n / 100), "property_management_rent_receipt": int64(n), "property_management_rent_receipt_line": int64(n),
		"graph view: invoice": 8, "graph view: contact": 4,
		"event": int64(n / 100), "event_session": int64(n / 10), "event_booking": int64(n),
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

	// Events: seat counts match the bookings holding seats and never pass
	// capacity; every booking has a contact; past sessions carry check-ins.
	if got := one(`SELECT count(*) FROM event_session s WHERE s.tenant_id = $1 AND (s.seats_taken > s.capacity OR s.seats_taken <>
		(SELECT coalesce(sum(b.seats), 0) FROM event_booking b WHERE b.session_id = s.id AND b.status IN ('confirmed', 'attended', 'no_show')))`); got != 0 {
		t.Errorf("%v sessions have seats_taken out of step with their bookings", got)
	}
	if got := one(`SELECT count(*) FROM event_booking WHERE tenant_id = $1 AND (contact_id IS NULL OR starts_at IS NULL OR length(cancel_token) <> 64)`); got != 0 {
		t.Errorf("%v bookings lack a contact, start or cancel token", got)
	}
	if got := one(`SELECT count(*) FROM event_booking WHERE tenant_id = $1 AND status = 'attended' AND starts_at > now()`); got != 0 {
		t.Errorf("%v future bookings are checked in", got)
	}
	for _, status := range []string{"confirmed", "attended", "no_show", "cancelled"} {
		if got := one(`SELECT count(*) FROM event_booking WHERE tenant_id = $1 AND status = '` + status + `'`); got == 0 {
			t.Errorf("no %s bookings seeded", status)
		}
	}
	if got := one(`SELECT count(*) FROM event_booking WHERE tenant_id = $1 AND slot_start IS NOT NULL`); got == 0 {
		t.Error("no appointment bookings seeded")
	}

	if _, err := devseed.Seed(ctx, app.DB, tenant, n, nil); !errors.Is(err, devseed.ErrAlreadySeeded) {
		t.Fatalf("second run: %v, want ErrAlreadySeeded", err)
	}
}

// A selection seeds only those groups plus what they reference; a later run
// seeds the rest, reusing the earlier rows instead of seeding them twice.
func TestSeed_Groups(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "graphfield", "contact", "crm", "warehouse", "sale", "propertymanagement", "event")
	ctx := context.Background()
	tenant := uuid.New()
	t.Cleanup(func() {
		for _, table := range seededTables {
			_, _ = app.DB.Exec(ctx, "DELETE FROM "+table+" WHERE tenant_id = $1", tenant)
		}
	})
	if _, err := app.DB.Exec(ctx, "INSERT INTO company (tenant_id, name, currency, is_default) VALUES ($1, 'Home', 'EUR', true)", tenant); err != nil {
		t.Fatal(err)
	}
	const n = 1000 // 10 events, 2 of them appointment events (one in five)
	count := func(table string) int {
		t.Helper()
		var c int
		if err := app.DB.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE tenant_id = $1", tenant).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}

	if _, err := devseed.Seed(ctx, app.DB, tenant, n, []string{"crm"}); err != nil {
		t.Fatal(err)
	}
	if count("crm") != n || count("contact") != n || count("invoice") != 0 || count("product") != 0 {
		t.Fatalf("crm only: crm %d contact %d invoice %d product %d", count("crm"), count("contact"), count("invoice"), count("product"))
	}

	if _, err := devseed.Seed(ctx, app.DB, tenant, n, []string{"invoices"}); err != nil {
		t.Fatal(err)
	}
	if count("invoice") != n || count("product") != n || count("contact") != n || count("quote") != 0 {
		t.Fatalf("then invoices: invoice %d product %d contact %d (want no second batch) quote %d",
			count("invoice"), count("product"), count("contact"), count("quote"))
	}
	var orphans int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM invoice i WHERE i.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.id = i.customer_id)`, tenant).Scan(&orphans)
	if orphans != 0 {
		t.Errorf("%d invoices point at no seeded contact", orphans)
	}

	status, err := devseed.Groups(ctx, app.DB, tenant)
	if err != nil {
		t.Fatal(err)
	}
	seeded := map[string]bool{}
	for _, g := range status {
		seeded[g.Key] = g.Seeded
	}
	for key, want := range map[string]bool{"contacts": true, "crm": true, "products": true, "base": true, "invoices": true, "quotes": false, "events": false} {
		if seeded[key] != want {
			t.Errorf("group %s seeded = %v, want %v", key, seeded[key], want)
		}
	}

	// All groups: only the remaining ones are written.
	if _, err := devseed.Seed(ctx, app.DB, tenant, n, nil); err != nil {
		t.Fatal(err)
	}
	if count("quote") != n || count("event_booking") != n || count("invoice") != n || count("crm") != n {
		t.Errorf("rest: quote %d booking %d invoice %d crm %d", count("quote"), count("event_booking"), count("invoice"), count("crm"))
	}
	if _, err := devseed.Seed(ctx, app.DB, tenant, n, []string{"crm"}); !errors.Is(err, devseed.ErrAlreadySeeded) {
		t.Errorf("re-seeding a seeded group: %v, want ErrAlreadySeeded", err)
	}
	if _, err := devseed.Seed(ctx, app.DB, tenant, n, []string{"nope"}); !errors.Is(err, devseed.ErrUnknownGroup) {
		t.Errorf("unknown group: %v, want ErrUnknownGroup", err)
	}
}
