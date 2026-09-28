// Package devseed is the backend half of Settings → Developer's "full"
// demo-data volume: ~100 000 rows per business table, written with
// set-based SQL (INSERT … SELECT FROM generate_series) so it takes seconds
// instead of the hours a per-row HTTP seed would. The "light" volume stays
// the frontend's own generic-API seed (core-front/apps/shell/src/lib/dev-seed.ts).
//
// Development-only and once per tenant: the handler refuses outside
// environment "development", and a marker setting (MarkerKey) makes a second
// run a 409 instead of doubling the data.
package devseed

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// MarkerKey is the tenant-level app_settings key recording a full seed.
const MarkerKey = "dev.seed.full"

// Result is one table's seeded row count.
type Result struct {
	Entity  string `json:"entity"`
	Created int64  `json:"created"`
}

// ErrAlreadySeeded is returned when MarkerKey already exists for the tenant.
var ErrAlreadySeeded = fmt.Errorf("the full demo volume was already seeded for this workspace")

// step is one set-based statement; entity names its Result row ("" = none).
type step struct {
	entity string
	sql    string
}

// analyze indexes a temp table's dense idx and refreshes planner statistics
// for it and the tables it was built from: fresh bulk-loaded tables have no
// stats, and the planner then picks nested loops that turn 100k × 100k joins
// into minutes.
// analyze2 refreshes statistics of bulk-loaded tables (no temp table).
func analyze2(tables ...string) []step {
	out := make([]step, 0, len(tables))
	for _, t := range tables {
		out = append(out, step{sql: "ANALYZE " + t})
	}
	return out
}

func analyze(temp string, tables ...string) []step {
	out := []step{{sql: "CREATE UNIQUE INDEX ON " + temp + " (idx)"}, {sql: "ANALYZE " + temp}}
	for _, t := range tables {
		out = append(out, step{sql: "ANALYZE " + t})
	}
	return out
}

// Seed writes the full volume for tenantID: n rows each of contacts, CRM
// leads, products, variants, quotes, invoices and rent receipts (quote and
// invoice lines at 2 per document, sale-line tax tags on a share of them),
// plus extra companies, the tax catalog, tags and 1 property per 100
// receipts — then Graph views and calculated fields for every list-view
// entity that ends up over GraphThreshold rows (graphs.go). One transaction:
// all or nothing.
func Seed(ctx context.Context, db *orm.DB, tenantID uuid.UUID, n int) ([]Result, error) {
	var results []Result
	err := db.Transaction(ctx, func(tx *orm.Tx) error {
		var seeded bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM app_settings WHERE tenant_id = $1 AND company_id IS NULL AND key = $2 AND deleted_at IS NULL)`,
			tenantID, MarkerKey).Scan(&seeded); err != nil {
			return fmt.Errorf("devseed: marker: %w", err)
		}
		if seeded {
			return ErrAlreadySeeded
		}
		// Deterministic data run to run (random() is seeded per session).
		if _, err := tx.Exec(ctx, `SELECT setseed(0.42)`); err != nil {
			return fmt.Errorf("devseed: setseed: %w", err)
		}
		for _, s := range steps {
			args := []any{tenantID, n}
			if !strings.Contains(s.sql, "$1") { // ANALYZE / CREATE INDEX take no parameters
				args = nil
			}
			tag, err := tx.Exec(ctx, s.sql, args...)
			if err != nil {
				return fmt.Errorf("devseed: %s: %w", s.entity, err)
			}
			if s.entity != "" {
				results = append(results, Result{Entity: s.entity, Created: tag.RowsAffected()})
			}
		}
		graphResults, err := seedGraphs(ctx, tx, tenantID)
		if err != nil {
			return err
		}
		results = append(results, graphResults...)
		_, err = tx.Exec(ctx,
			`INSERT INTO app_settings (tenant_id, company_id, key, value) VALUES ($1, NULL, $2, $3)`,
			tenantID, MarkerKey, time.Now().UTC().Format(time.RFC3339))
		return err
	})
	return results, err
}

// Pitfall: an uncorrelated LATERAL (SELECT … random()) is evaluated ONCE,
// not per row — every row gets the same value. Per-row variety comes from
// random() in the select list, or a hash of the row's generate_series index.
//
// Every statement takes $1 = tenant id, $2 = n (Postgres needs both used or
// typed, hence the occasional "$2::int IS NOT NULL" no-op). Temp tables
// (ON COMMIT DROP) give the seeded rows a dense 1..n index so later steps can
// pick "a random contact/variant" with a cheap equi-join instead of ORDER BY
// random(). Money columns are rounded to cents; tax rates are 0..1 fractions
// like the app's own (sale.computeLineTotal).
var steps = slices.Concat([]step{
	{"company", `
INSERT INTO company (tenant_id, name, address_number, address_street, address_zip_code, address_city, address_country, phone, email, currency, is_default)
SELECT $1, v.name, v.num, v.street, v.zip, v.city, v.country, v.phone, v.email, v.currency, false
FROM (VALUES
  ('Northwind Europe SAS', 12, 'Rue de la Paix', '75002', 'Paris', 'France', '+33 1 55 00 00 00', 'contact@northwind-eu.example', 'EUR'),
  ('Northwind UK Ltd', 221, 'Baker Street', 'NW1 6XE', 'London', 'United Kingdom', '+44 20 7946 0000', 'hello@northwind-uk.example', 'GBP'),
  ('Northwind Americas Inc', 350, 'Fifth Avenue', '10118', 'New York', 'United States', '+1 212 555 0100', 'sales@northwind-us.example', 'USD')
) AS v(name, num, street, zip, city, country, phone, email, currency)
WHERE $2::int IS NOT NULL`},

	{"", `
CREATE TEMP TABLE seed_companies ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY is_default DESC, name) AS idx, name, address_number, address_street, address_zip_code, address_city, address_country, phone, email
FROM company WHERE tenant_id = $1 AND deleted_at IS NULL AND $2::int IS NOT NULL`},
}, analyze("seed_companies", "company"), []step{

	{"sale_tax", `
INSERT INTO sale_tax (tenant_id, name, kind, rate, amount)
SELECT $1, v.name, v.kind, v.rate, v.amount
FROM (VALUES
  ('VAT 20%', 'percentage', 0.2, 0), ('VAT 10%', 'percentage', 0.1, 0), ('VAT 5.5%', 'percentage', 0.055, 0),
  ('VAT 2.1%', 'percentage', 0.021, 0), ('Local levy 1%', 'percentage', 0.01, 0), ('Eco-participation', 'fixed', 0, 0.5)
) AS v(name, kind, rate, amount)
WHERE $2::int IS NOT NULL`},

	{"product", `
INSERT INTO product (tenant_id, name, reference, unit, unit_price, tax_rate, created_at)
SELECT $1,
  (ARRAY['Premium','Compact','Industrial','Eco','Pro','Smart','Classic','Heavy-duty','Wireless','Modular','Organic','Deluxe'])[1 + i % 12]
    || ' ' || (ARRAY['drill','consulting hour','server rack','desk','sensor','cable','license','pump','valve','lamp','router','chair','panel','filter','battery','training day','printer','monitor','bracket','gasket'])[1 + (i / 12) % 20]
    || ' ' || i,
  'SEED-' || lpad(i::text, 6, '0'),
  (ARRAY['pcs','hour','month','kg','m'])[1 + i % 5],
  round((5 + random() * 1995)::numeric, 2),
  CASE WHEN i % 10 < 6 THEN 0.2 WHEN i % 10 < 8 THEN 0.1 WHEN i % 10 < 9 THEN 0.055 ELSE 0.021 END,
  now() - random() * interval '730 days'
FROM generate_series(1, $2) AS i`},

	{"product_variant", `
INSERT INTO product_variant (tenant_id, product_id, name, unit_price, tax_rate, created_at)
SELECT $1, p.id, p.name || ' — ' || (ARRAY['S','M','L','XL','Standard','Plus'])[1 + (row_number() OVER (ORDER BY p.reference))::int % 6],
  CASE WHEN random() < 0.3 THEN round((p.unit_price * (0.9 + random() * 0.3))::numeric, 2) END,
  CASE WHEN random() < 0.05 THEN 0.055 END,
  p.created_at
FROM product p WHERE p.tenant_id = $1 AND p.reference LIKE 'SEED-%' AND $2::int IS NOT NULL`},

	{"", `
CREATE TEMP TABLE seed_variants ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY p.reference) AS idx, v.id, v.name, p.unit,
  COALESCE(v.unit_price, p.unit_price) AS price, COALESCE(v.tax_rate, p.tax_rate) AS rate
FROM product_variant v JOIN product p ON p.id = v.product_id
WHERE v.tenant_id = $1 AND p.reference LIKE 'SEED-%' AND $2::int IS NOT NULL`},
}, analyze("seed_variants", "product", "product_variant"), []step{

	{"contact", `
INSERT INTO contact (tenant_id, name, email, company, status, created_at)
SELECT $1, f.first || ' ' || l.last,
  lower(f.first || '.' || l.last || '.' || i) || '@' || lower(replace(c.company, ' ', '')) || '.seed.example',
  c.company,
  (ARRAY['lead','prospect','customer','customer','churned'])[1 + i % 5],
  now() - random() * interval '1095 days'
FROM generate_series(1, $2) AS i
CROSS JOIN LATERAL (SELECT (ARRAY['Ava','Liam','Maya','Noah','Elena','Lucas','Sofia','Mateo','Nina','Kenji','Zoe','Omar','Ines','Theo','Amara','Felix'])[1 + i % 16] AS first) f
CROSS JOIN LATERAL (SELECT (ARRAY['Bennett','Nguyen','Kowalski','Okafor','Rossi','Dubois','Larsen','Haddad','Petrova','Silva','Andersen','Moreau','Kimura','Novak','Adeyemi','Costa'])[1 + (i / 16) % 16] AS last) l
CROSS JOIN LATERAL (SELECT (ARRAY['Northwind Logistics','Bluepeak Robotics','Cedarline Foods','Vantage Analytics','Solara Energy','Ironhall Manufacturing','Driftwood Studio','Meridian Health','Quillfeather Media','Basalt Construction','Fernbridge Capital','Amberwood Retail'])[1 + (i / 7) % 12] AS company) c`},

	{"", `
CREATE TEMP TABLE seed_contacts ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY created_at, id) AS idx, id, name, email, company
FROM contact WHERE tenant_id = $1 AND email LIKE '%.seed.example' AND $2::int IS NOT NULL`},
}, analyze("seed_contacts", "contact"), []step{

	{"crm", `
INSERT INTO crm (tenant_id, name, email, company, status, contact_id, phone, notes, satisfaction, deals, score, created_at)
SELECT $1, c.name, c.email, c.company, s.status, c.id,
  '+1 555 ' || lpad((c.idx % 10000)::text, 4, '0'),
  (ARRAY['Introduced via the autumn trade show.','Wants a pilot before committing to the full package.','Existing customer looking to expand seats.','Referred by an existing account.','Following up after a stalled quarter.','Comparing us against two other vendors.'])[1 + c.idx % 6],
  round((1 + random() * 4)::numeric, 1),
  (random() * 20)::bigint,
  CASE s.status WHEN 'incoming' THEN 1 WHEN 'running' THEN 2 WHEN 'won' THEN 3 ELSE 0 END,
  now() - random() * interval '730 days'
FROM seed_contacts c
CROSS JOIN LATERAL (SELECT (ARRAY['incoming','running','running','won','lost','closed'])[1 + c.idx % 6] AS status) s
WHERE $2::int IS NOT NULL`},

	{"tag", `
INSERT INTO tag (tenant_id, name)
SELECT $1, v.name FROM (VALUES ('VIP'), ('Newsletter'), ('Hot lead'), ('Enterprise'), ('Churn risk'), ('Partner')) AS v(name)
WHERE $2::int IS NOT NULL`},

	{"crm_tag", `
INSERT INTO crm_tag (tenant_id, crm_id, tag_id)
SELECT $1, r.id, t.id
FROM (SELECT id, row_number() OVER (ORDER BY id) AS idx FROM crm WHERE tenant_id = $1 AND email LIKE '%.seed.example') r
JOIN (SELECT id, row_number() OVER (ORDER BY created_at DESC, id) - 1 AS idx FROM tag WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 6) t
  ON t.idx = r.idx % 6
WHERE $2::int IS NOT NULL`},

	{"quote", `
INSERT INTO quote (tenant_id, number, issue_date, due_date, subject, customer_id, customer_name, customer_email,
  customer_address_city, customer_address_country, status, reference,
  issuer_name, issuer_address_number, issuer_address_street, issuer_address_zip_code, issuer_address_city, issuer_address_country, issuer_phone, issuer_email,
  payment_method, payment_terms, created_at)
SELECT $1, 'SQ-' || lpad(i::text, 6, '0'), d.issued, d.issued + interval '30 days',
  (ARRAY['Annual maintenance','Equipment renewal','Consulting engagement','Pilot project','Support extension','Training programme'])[1 + i % 6],
  c.id, c.name, c.email,
  (ARRAY['Paris','London','New York','Berlin','Madrid','Montreal'])[1 + i % 6], (ARRAY['France','United Kingdom','United States','Germany','Spain','Canada'])[1 + i % 6],
  (ARRAY['draft','sent','sent','accepted','accepted','declined','expired'])[1 + i % 7],
  'PO-' || (100000 + i),
  co.name, co.address_number, co.address_street, co.address_zip_code, co.address_city, co.address_country, co.phone, co.email,
  (ARRAY['Bank transfer','Credit card','Check'])[1 + i % 3], (ARRAY['Net 30','Net 15','Due on receipt'])[1 + i % 3],
  d.issued
FROM generate_series(1, $2) AS i
CROSS JOIN LATERAL (SELECT date_trunc('day', now()) - ((i::bigint * 2654435761) % 730) * interval '1 day' AS issued) d
JOIN seed_contacts c ON c.idx = 1 + (i::bigint * 7919) % $2
JOIN seed_companies co ON co.idx = 1 + i % (SELECT count(*) FROM seed_companies)`},

	{"", `
CREATE TEMP TABLE seed_quotes ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY number) AS idx, id, status FROM quote WHERE tenant_id = $1 AND number LIKE 'SQ-%' AND $2::int IS NOT NULL`},
}, analyze("seed_quotes", "quote"), []step{

	{"quote_line", `
INSERT INTO quote_line (tenant_id, quote_id, variant_id, variant_name, quantity, unit, tax_rate, unit_price)
SELECT $1, q.id, v.id, v.name, 1 + (random() * 9)::int, v.unit, v.rate, v.price
FROM seed_quotes q CROSS JOIN generate_series(1, 2) AS k
JOIN seed_variants v ON v.idx = 1 + (q.idx * 31 + k * 7919) % $2`},
}, analyze2("quote_line"), []step{
	{"", `
UPDATE quote q SET subtotal = s.sub, tax_amount = s.tax, total = s.sub + s.tax
FROM (SELECT l.quote_id, round(sum(l.quantity * l.unit_price)::numeric, 2)::float8 AS sub,
             round(sum(l.quantity * l.unit_price * l.tax_rate)::numeric, 2)::float8 AS tax
      FROM quote_line l JOIN seed_quotes sq ON sq.id = l.quote_id GROUP BY l.quote_id) s
WHERE q.id = s.quote_id AND q.tenant_id = $1 AND $2::int IS NOT NULL`},

	{"invoice", `
INSERT INTO invoice (tenant_id, number, issue_date, due_date, subject, customer_id, customer_name, customer_email,
  customer_address_city, customer_address_country, status, reference, quote_id,
  issuer_name, issuer_address_number, issuer_address_street, issuer_address_zip_code, issuer_address_city, issuer_address_country, issuer_phone, issuer_email,
  payment_method, payment_terms, created_at)
SELECT $1, 'SI-' || lpad(i::text, 6, '0'), d.issued, d.issued + interval '30 days',
  (ARRAY['Annual maintenance','Equipment renewal','Consulting engagement','Pilot project','Support extension','Training programme'])[1 + i % 6],
  c.id, c.name, c.email,
  (ARRAY['Paris','London','New York','Berlin','Madrid','Montreal'])[1 + i % 6], (ARRAY['France','United Kingdom','United States','Germany','Spain','Canada'])[1 + i % 6],
  CASE WHEN d.issued > now() - interval '30 days' THEN (ARRAY['draft','sent'])[1 + i % 2]
       ELSE (ARRAY['paid','paid','paid','sent','overdue','cancelled'])[1 + i % 6] END,
  'PO-' || (200000 + i),
  CASE WHEN q.status = 'accepted' THEN q.id END,
  co.name, co.address_number, co.address_street, co.address_zip_code, co.address_city, co.address_country, co.phone, co.email,
  (ARRAY['Bank transfer','Credit card','Check'])[1 + i % 3], (ARRAY['Net 30','Net 15','Due on receipt'])[1 + i % 3],
  d.issued
FROM generate_series(1, $2) AS i
CROSS JOIN LATERAL (SELECT date_trunc('day', now()) - ((i::bigint * 40503) % 730) * interval '1 day' AS issued) d
JOIN seed_contacts c ON c.idx = 1 + (i::bigint * 104729) % $2
JOIN seed_companies co ON co.idx = 1 + i % (SELECT count(*) FROM seed_companies)
LEFT JOIN seed_quotes q ON q.idx = i`},

	{"", `
CREATE TEMP TABLE seed_invoices ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY number) AS idx, id FROM invoice WHERE tenant_id = $1 AND number LIKE 'SI-%' AND $2::int IS NOT NULL`},
}, analyze("seed_invoices", "invoice"), []step{

	{"sale_line", `
INSERT INTO sale_line (tenant_id, invoice_id, variant_id, variant_name, quantity, unit, tax_rate, unit_price, subtotal, total)
SELECT $1, inv.id, v.id, v.name, l.qty, v.unit, v.rate, v.price,
  round((l.qty * v.price)::numeric, 2), round((l.qty * v.price * (1 + v.rate))::numeric, 2)
FROM seed_invoices inv CROSS JOIN generate_series(1, 2) AS k
JOIN seed_variants v ON v.idx = 1 + (inv.idx * 17 + k * 104729) % $2
CROSS JOIN LATERAL (SELECT 1 + (inv.idx * 7 + k * 3) % 10 AS qty) l`},

	// Multiple taxes: a quarter of the lines also carry the 1% local levy,
	// ~15% the fixed eco-participation — tags on top of the line's own VAT
	// rate, exactly how sale.computeLineTotal stacks them. The pick hashes
	// the line id rather than calling random(): the planner pushes a
	// volatile random() filter down into the 6-row sale_tax scan, drawing
	// once per TAX instead of once per line (all lines or none).
	{"sale_line_tax", `
INSERT INTO sale_line_tax (tenant_id, sale_line_id, sale_tax_id)
SELECT $1, l.id, t.id
FROM sale_line l JOIN seed_invoices si ON si.id = l.invoice_id
JOIN LATERAL (SELECT id, name FROM sale_tax WHERE tenant_id = $1 AND name IN ('Local levy 1%', 'Eco-participation') ORDER BY created_at DESC) t ON true
WHERE ((t.name = 'Local levy 1%' AND abs(hashtext(l.id::text)) % 100 < 25)
    OR (t.name = 'Eco-participation' AND abs(hashtext(l.id::text || 'eco')) % 100 < 15))
  AND $2::int IS NOT NULL`},
}, analyze2("sale_line", "sale_line_tax"), []step{
	{"", `
UPDATE sale_line l SET total = round((l.subtotal * (1 + l.tax_rate + x.rate) + x.fixed)::numeric, 2)
FROM (SELECT slt.sale_line_id,
             sum(CASE WHEN t.kind = 'fixed' THEN 0 ELSE t.rate END) AS rate,
             sum(CASE WHEN t.kind = 'fixed' THEN t.amount ELSE 0 END) AS fixed
      FROM sale_line_tax slt JOIN sale_tax t ON t.id = slt.sale_tax_id
      WHERE slt.tenant_id = $1 GROUP BY slt.sale_line_id) x
WHERE l.id = x.sale_line_id AND $2::int IS NOT NULL`},

	{"", `
UPDATE invoice i SET subtotal = s.sub, tax_amount = round((s.tot - s.sub)::numeric, 2), total = s.tot
FROM (SELECT l.invoice_id, sum(l.subtotal) AS sub, sum(l.total) AS tot
      FROM sale_line l JOIN seed_invoices si ON si.id = l.invoice_id GROUP BY l.invoice_id) s
WHERE i.id = s.invoice_id AND i.tenant_id = $1 AND $2::int IS NOT NULL`},

	{"property_management", `
INSERT INTO property_management (tenant_id, name, address_number, address_street, address_zip_code, address_city, address_country, floor_area, loan_amount, rent_price, created_at)
SELECT $1, 'Seed property ' || lpad(i::text, 4, '0'), 1 + i % 200,
  (ARRAY['Maple Street','Harbor Row','Rue Victor Hugo','Kings Road','Elm Avenue','Canal Street'])[1 + i % 6], lpad((10000 + i)::text, 5, '0'),
  (ARRAY['Paris','London','Lyon','Manchester','Bordeaux','Leeds'])[1 + i % 6], (ARRAY['France','United Kingdom'])[1 + i % 2],
  round((20 + random() * 180)::numeric, 1), round((50000 + random() * 450000)::numeric, 0), round((400 + random() * 2600)::numeric, 0),
  now() - interval '9 years'
FROM generate_series(1, greatest($2 / 100, 1)) AS i`},
}, analyze2("property_management"), []step{
	// Rent receipts: exactly n, spread over the properties round-robin and
	// walking back one month per round (100 months for the full volume). A
	// quarter of the properties are commercial leases with 20% VAT; rent
	// drifts ±5% month to month.
	{"property_management_rent_receipt", `
INSERT INTO property_management_rent_receipt (tenant_id, property_management_id, period, generated_at, property_name, property_address,
  floor_area, uom, tenant_names, rent_price, subtotal, tax_amount, total, created_at)
SELECT $1, p.id, to_char(m.month, 'YYYY-MM'), m.month + interval '2 days', p.name,
  p.address_number || ' ' || p.address_street || ', ' || p.address_zip_code || ' ' || p.address_city,
  p.floor_area, 'm²', c.name, r.rent, r.rent, round((r.rent * p.rate)::numeric, 2), round((r.rent * (1 + p.rate))::numeric, 2),
  m.month + interval '2 days'
FROM generate_series(0, $2 - 1) AS i
CROSS JOIN LATERAL (SELECT count(*) AS n FROM property_management WHERE tenant_id = $1 AND name LIKE 'Seed property %') pc
JOIN (SELECT id, name, address_number, address_street, address_zip_code, address_city, floor_area, rent_price,
             row_number() OVER (ORDER BY name) - 1 AS idx, CASE WHEN row_number() OVER (ORDER BY name) % 4 = 0 THEN 0.2 ELSE 0 END AS rate
      FROM property_management WHERE tenant_id = $1 AND name LIKE 'Seed property %') p ON p.idx = i % pc.n
CROSS JOIN LATERAL (SELECT date_trunc('month', now()) - (i / pc.n) * interval '1 month' AS month) m
CROSS JOIN LATERAL (SELECT round((p.rent_price * (0.95 + (((i / pc.n) * 7919 + p.idx * 104729) % 1000) / 10000.0))::numeric, 2)::float8 AS rent) r
JOIN seed_contacts c ON c.idx = 1 + (p.idx * 97 + i / pc.n) % $2`},

	{"property_management_rent_receipt_line", `
INSERT INTO property_management_rent_receipt_line (tenant_id, rent_receipt_id, name, unit_price, tax_rate, tax_label, subtotal, total)
SELECT $1, r.id, 'Rent ' || r.period, r.subtotal, CASE WHEN r.tax_amount > 0 THEN 0.2 ELSE 0 END,
  CASE WHEN r.tax_amount > 0 THEN 'VAT 20%' ELSE '' END, r.subtotal, r.total
FROM property_management_rent_receipt r
WHERE r.tenant_id = $1 AND r.property_name LIKE 'Seed property %' AND $2::int IS NOT NULL`},
})
