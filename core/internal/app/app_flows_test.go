package app

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/types"
	"core/orm"

	"github.com/google/uuid"
)

// flow is a client that also hard-deletes, at cleanup, every row it created —
// the suite may run against the live dev DB, where the dev admin's tenant is
// the one a developer actually uses.
type flow struct{ *client }

func newFlow(t *testing.T) *flow { return &flow{buildApp(t)} }

// idOf reads the id of a created row: generic CRUD and the column-map
// overrides answer "id"; handlers returning the struct itself answer "ID".
func idOf(t *testing.T, body []byte) string {
	t.Helper()
	m := decode(t, body)
	for _, k := range []string{"id", "ID"} {
		if id, ok := m[k].(string); ok && id != "" {
			return id
		}
	}
	t.Fatalf("no id in %s", body)
	return ""
}

// zeroValues maps an ORM-derived SQL type to a value the generic create accepts.
var zeroValues = map[string]any{
	"TEXT": "", "BOOLEAN": false, "INTEGER": 0, "BIGINT": 0, "REAL": 0, "DOUBLE PRECISION": 0,
}

// withRequired returns fields plus a zero value for every other required
// (NOT NULL, non-UUID) column of table, so a test only spells out the fields
// it cares about. UUID columns (foreign keys) must be given explicitly.
func withRequired(t *testing.T, table string, fields map[string]any) map[string]any {
	t.Helper()
	cols, ok := orm.MigrationFieldsForTable(table)
	if !ok {
		t.Fatalf("%s is not registered", table)
	}
	body := map[string]any{}
	for _, c := range cols {
		if zero, ok := zeroValues[c.SQLType]; ok && !c.Nullable && !c.IsPK {
			body[c.Column] = zero
		}
	}
	for k, v := range fields {
		body[k] = v
	}
	return body
}

// create POSTs fields (completed by withRequired) to /api/v1/<table>, expects
// 201 and schedules a hard delete of the new row.
func (f *flow) create(table string, fields map[string]any) string {
	f.t.Helper()
	return f.createAt("/api/v1/"+table, table, withRequired(f.t, table, fields))
}

// createAt POSTs body to a dedicated route whose rows live in table.
func (f *flow) createAt(path, table string, body any) string {
	f.t.Helper()
	code, resp := f.do(http.MethodPost, path, body)
	if code != http.StatusCreated {
		f.t.Fatalf("POST %s: %d %s", path, code, resp)
	}
	id := idOf(f.t, resp)
	f.t.Cleanup(func() {
		// #nosec G201 -- table names are test constants.
		_, _ = f.a.db.DB.Exec(context.Background(), fmt.Sprintf(`DELETE FROM %s WHERE id = $1`, table), id)
	})
	return id
}

func (f *flow) expect(method, path string, body any, want int) []byte {
	f.t.Helper()
	code, resp := f.do(method, path, body)
	if code != want {
		f.t.Fatalf("%s %s: status %d, want %d: %s", method, path, code, want, resp)
	}
	return resp
}

// number reads a numeric field of a JSON object.
func number(t *testing.T, body []byte, key string) float64 {
	t.Helper()
	v, ok := decode(t, body)[key].(float64)
	if !ok {
		t.Fatalf("%s is not a number in %s", key, body)
	}
	return v
}

func TestApp_SaleFlow(t *testing.T) {
	// No report generation: Send emails without the PDF instead of calling a
	// pdf-service the test run doesn't start (the attachment path is covered
	// by modules/sale's workflow tests).
	f := &flow{buildAppWith(t, func(cfg *types.Config) { cfg.PDFServiceURL, cfg.NatsURL = "", "" })}

	taxIncluded := strings.Contains(string(f.expect(http.MethodGet, "/api/v1/settings/tax", nil, http.StatusOK)), "tax_included")

	product := f.create("product", map[string]any{"name": "App test product", "reference": "APP-TEST", "unit": "u", "unit_price": 10, "tax_rate": 0})
	variant := f.create("product_variant", map[string]any{"product_id": product})
	f.expect(http.MethodPost, "/api/v1/product_variant", map[string]any{"product_id": "00000000-0000-0000-0000-000000000000"}, http.StatusUnprocessableEntity)
	f.expect(http.MethodPost, "/api/v1/product_variant", "not an object", http.StatusBadRequest)

	invoice := f.create("invoice", map[string]any{})
	// The invoice/quote forms never send issuer_*: a blank issuer prints the
	// company profile instead, so a create without them must succeed.
	for _, table := range []string{"invoice", "quote"} {
		body := withRequired(t, table, map[string]any{})
		for k := range body {
			if strings.HasPrefix(k, "issuer_") {
				delete(body, k)
			}
		}
		f.createAt("/api/v1/"+table, table, body)
	}
	// A 422 names every missing field, so the form can list them for the user —
	// never the number, which the sequence always supplies.
	missing := string(f.expect(http.MethodPost, "/api/v1/invoice", map[string]any{}, http.StatusUnprocessableEntity))
	if !strings.Contains(missing, `"fields":[`) || !strings.Contains(missing, `"customer_name"`) || strings.Contains(missing, `"number"`) {
		t.Errorf("422 body lacks the missing field list (or names number): %s", missing)
	}
	tax := f.create("sale_tax", map[string]any{"name": "VAT", "kind": "percentage", "rate": 0.2})

	line := f.create("sale_line", map[string]any{"invoice_id": invoice, "variant_id": variant, "quantity": 2})
	f.expect(http.MethodPost, "/api/v1/sale_line", map[string]any{"invoice_id": invoice, "variant_id": invoice, "quantity": 1}, http.StatusUnprocessableEntity)
	f.expect(http.MethodPost, "/api/v1/sale_line", "not an object", http.StatusBadRequest)

	lineTax := f.create("sale_line_tax", map[string]any{"sale_line_id": line, "sale_tax_id": tax})
	f.expect(http.MethodPut, "/api/v1/sale_line/"+line, map[string]any{"quantity": 3}, http.StatusOK)
	f.expect(http.MethodPut, "/api/v1/sale_line/not-a-uuid", map[string]any{"quantity": 3}, http.StatusBadRequest)

	// 3 × 10 with a 20% tax: 36 on top of the price, or 30 with tax already included.
	want := 36.0
	if taxIncluded {
		want = 30
	}
	got := number(t, f.expect(http.MethodGet, "/api/v1/invoice/"+invoice, nil, http.StatusOK), "total")
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("invoice total = %v, want %v", got, want)
	}

	f.expect(http.MethodDelete, "/api/v1/sale_line_tax/"+lineTax, nil, http.StatusNoContent)
	f.expect(http.MethodDelete, "/api/v1/sale_line/"+line, nil, http.StatusNoContent)
	f.expect(http.MethodDelete, "/api/v1/sale_line/"+line, nil, http.StatusNotFound)

	quote := f.create("quote", map[string]any{})
	quoteLine := f.create("quote_line", map[string]any{"quote_id": quote, "variant_id": variant, "quantity": 1})
	f.expect(http.MethodPut, "/api/v1/quote_line/"+quoteLine, map[string]any{"quantity": 4}, http.StatusOK)
	f.expect(http.MethodDelete, "/api/v1/quote_line/"+quoteLine, nil, http.StatusNoContent)

	testSaleWorkflow(t, f, variant)
}

// testSaleWorkflow drives a quote from creation to its invoice: sequence
// numbers, the one-line rule, confirm/send/accept and the conversion.
func testSaleWorkflow(t *testing.T, f *flow, variant string) {
	year := strconv.Itoa(time.Now().Year())
	str := func(body []byte, key string) string {
		t.Helper()
		v, _ := decode(t, body)[key].(string)
		return v
	}
	record := func(body []byte) map[string]any {
		t.Helper()
		rec, _ := decode(t, body)["record"].(map[string]any)
		return rec
	}

	// The number is the sequence's, never the one typed; each create takes the next.
	q1 := f.create("quote", map[string]any{"number": "TYPED", "customer_name": "Ada", "customer_email": "ada@example.test"})
	q2 := f.create("quote", map[string]any{"customer_name": "Bob"})
	n1 := str(f.expect(http.MethodGet, "/api/v1/quote/"+q1, nil, http.StatusOK), "number")
	n2 := str(f.expect(http.MethodGet, "/api/v1/quote/"+q2, nil, http.StatusOK), "number")
	if !strings.HasPrefix(n1, "Q-"+year+"-") || n1 == n2 {
		t.Fatalf("quote numbers = %q, %q, want two distinct Q-%s-NNNN", n1, n2, year)
	}
	// An edit never changes it.
	f.expect(http.MethodPut, "/api/v1/quote/"+q1, withRequired(t, "quote", map[string]any{
		"number": "CHANGED", "customer_name": "Ada", "customer_email": "ada@example.test", "status": "draft",
	}), http.StatusOK)
	if got := str(f.expect(http.MethodGet, "/api/v1/quote/"+q1, nil, http.StatusOK), "number"); got != n1 {
		t.Errorf("number after an edit = %q, want %q", got, n1)
	}

	// No line: neither Confirm nor a plain edit can move it past draft.
	f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/confirm", nil, http.StatusUnprocessableEntity)
	f.expect(http.MethodPut, "/api/v1/quote/"+q1, withRequired(t, "quote", map[string]any{
		"customer_name": "Ada", "customer_email": "ada@example.test", "status": "confirmed",
	}), http.StatusUnprocessableEntity)
	// Out of order: only a sent quote can be accepted, a confirmed one sent.
	f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/accept", nil, http.StatusConflict)
	f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/send", nil, http.StatusConflict)

	f.create("quote_line", map[string]any{"quote_id": q1, "variant_id": variant, "quantity": 3})
	if got := record(f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/confirm", nil, http.StatusOK))["status"]; got != "confirmed" {
		t.Fatalf("confirmed quote status = %v", got)
	}
	f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/confirm", nil, http.StatusConflict)

	sent := decode(t, f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/send", nil, http.StatusOK))
	if to, _ := sent["sent_to"].([]any); len(to) != 1 || to[0] != "ada@example.test" {
		t.Errorf("sent_to = %v, want the customer's email", sent["sent_to"])
	}

	accepted := decode(t, f.expect(http.MethodPost, "/api/v1/quote/"+q1+"/accept", nil, http.StatusOK))
	invoiceID, _ := accepted["invoice_id"].(string)
	if rec, _ := accepted["record"].(map[string]any); rec["status"] != "accepted" || invoiceID == "" {
		t.Fatalf("accept = %v", accepted)
	}
	inv := decode(t, f.expect(http.MethodGet, "/api/v1/invoice/"+invoiceID, nil, http.StatusOK))
	if num, _ := inv["number"].(string); !strings.HasPrefix(num, "INV-"+year+"-") || inv["status"] != "draft" || inv["quote_id"] != q1 {
		t.Errorf("converted invoice = number %v, status %v, quote_id %v", inv["number"], inv["status"], inv["quote_id"])
	}
	lines := f.expect(http.MethodGet, "/api/v1/sale_line?filter[invoice_id]="+invoiceID, nil, http.StatusOK)
	if !strings.Contains(string(lines), `"quantity":3`) {
		t.Errorf("converted invoice lines = %s, want the quote's line", lines)
	}

	// The invoice follows the same steps.
	if got := record(f.expect(http.MethodPost, "/api/v1/invoice/"+invoiceID+"/confirm", nil, http.StatusOK))["status"]; got != "confirmed" {
		t.Errorf("confirmed invoice status = %v", got)
	}
	f.expect(http.MethodPost, "/api/v1/invoice/"+invoiceID+"/send", nil, http.StatusOK)
	empty := f.create("invoice", map[string]any{"customer_name": "Nobody"})
	f.expect(http.MethodPost, "/api/v1/invoice/"+empty+"/confirm", nil, http.StatusUnprocessableEntity)
	f.expect(http.MethodPost, "/api/v1/invoice/not-a-uuid/confirm", nil, http.StatusBadRequest)
}

func TestApp_PropertyManagementFlow(t *testing.T) {
	f := newFlow(t)

	property := f.create("property_management", map[string]any{
		"name": "App test flat", "rent_price": 500, "floor_area": 40, "loan_amount": 0,
		"address_complement": "", "address_street": "1 test street", "address_zip_code": "75000",
		"address_city": "Paris", "address_state": "", "address_country": "FR",
	})
	body := f.expect(http.MethodGet, "/api/v1/property_management/"+property, nil, http.StatusOK)
	if _, ok := decode(t, body)["receipt_generated_this_month"]; !ok {
		t.Errorf("GET property lacks receipt_generated_this_month: %s", body)
	}
	f.expect(http.MethodGet, "/api/v1/property_management/not-a-uuid", nil, http.StatusBadRequest)

	equipment := f.create("property_management_equipment", map[string]any{"property_management_id": property, "name": "Oven", "quantity": 1})
	f.create("property_management_equipment_status", map[string]any{"property_management_equipment_id": equipment, "state": "broken"})
	if got := decode(t, f.expect(http.MethodGet, "/api/v1/property_management_equipment/"+equipment, nil, http.StatusOK))["current_state"]; got != "broken" {
		t.Errorf("equipment current_state = %v, want the latest status (broken)", got)
	}

	tax := f.create("sale_tax", map[string]any{"name": "VAT", "kind": "fixed", "amount": 5})
	line := f.create("property_management_billing_line", map[string]any{"property_management_id": property, "name": "Rent", "unit_price": 500})
	lineTax := f.create("property_management_billing_line_tax", map[string]any{"property_management_billing_line_id": line, "sale_tax_id": tax})
	f.expect(http.MethodPut, "/api/v1/property_management_billing_line/"+line, map[string]any{"unit_price": 600}, http.StatusOK)
	f.expect(http.MethodDelete, "/api/v1/property_management_billing_line_tax/"+lineTax, nil, http.StatusNoContent)

	receipt := f.create("property_management_rent_receipt", map[string]any{"property_management_id": property})
	f.create("property_management_rent_receipt_line", map[string]any{"rent_receipt_id": receipt, "name": "Rent", "unit_price": 500})
	// Receipts are editable but never deletable.
	f.expect(http.MethodPut, "/api/v1/property_management_rent_receipt/"+receipt, map[string]any{"period": "2026-09"}, http.StatusOK)
	f.expect(http.MethodDelete, "/api/v1/property_management_rent_receipt/"+receipt, nil, http.StatusForbidden)
}

func TestApp_OverrideFlows(t *testing.T) {
	f := newFlow(t)

	cronID := f.create("cron", map[string]any{"name": "App test cron", "action_id": "cron.history_retention"})
	body := f.expect(http.MethodPut, "/api/v1/cron/"+cronID, map[string]any{"name": "Renamed"}, http.StatusOK)
	if got := decode(t, body)["action_code"]; got == nil || got == "" {
		t.Errorf("cron action_code not resolved from the registry: %s", body)
	}
	f.expect(http.MethodPut, "/api/v1/cron/not-a-uuid", map[string]any{}, http.StatusBadRequest)
	f.expect(http.MethodPut, "/api/v1/cron/00000000-0000-0000-0000-000000000000", map[string]any{}, http.StatusNotFound)

	f.create("crm", map[string]any{"name": "App test lead"})
	f.expect(http.MethodPost, "/api/v1/crm", "not an object", http.StatusBadRequest)
}

func TestApp_AdminAndRecordFeatures(t *testing.T) {
	f := newFlow(t)

	// Users and roles administration.
	role := f.createAt("/api/v1/roles", "roles", map[string]any{"name": "App test role", "technical_name": "app_test_role"})
	f.expect(http.MethodGet, "/api/v1/roles/"+role, nil, http.StatusOK)
	f.expect(http.MethodPut, "/api/v1/roles/"+role, map[string]any{"name": "App test role", "description": "renamed"}, http.StatusOK)
	user := f.createAt("/api/v1/users", "users", map[string]any{"email": "app-test@example.invalid", "name": "App"})
	f.expect(http.MethodGet, "/api/v1/users/"+user, nil, http.StatusOK)
	f.expect(http.MethodPut, "/api/v1/users/"+user, map[string]any{"email": "app-test@example.invalid", "job_title": "Tester"}, http.StatusOK)
	f.expect(http.MethodGet, "/api/v1/users/not-a-uuid", nil, http.StatusBadRequest)

	// Per-record features, anchored on a throwaway CRM row.
	record := f.create("crm", map[string]any{"name": "App test anchor"})
	page := f.createAt("/api/v1/notebook_pages", "notebook_page", map[string]any{"table_name": "crm", "record_id": record, "title": "Notes", "content": "x"})
	f.expect(http.MethodPut, "/api/v1/notebook_pages/"+page, map[string]any{"title": "Notes", "content": "y"}, http.StatusOK)
	f.expect(http.MethodDelete, "/api/v1/notebook_pages/"+page, nil, http.StatusNoContent)

	filter := f.createAt("/api/v1/saved_filters", "saved_filter", map[string]any{"entity": "crm", "name": "App test filter", "config": "{}"})
	f.expect(http.MethodPut, "/api/v1/saved_filters/"+filter, map[string]any{"name": "App test filter 2", "shared": true, "config": "{}"}, http.StatusOK)
	f.expect(http.MethodDelete, "/api/v1/saved_filters/"+filter, nil, http.StatusNoContent)

	f.createAt("/api/v1/chatter_messages", "chatter_message", map[string]any{"table_name": "crm", "record_id": record, "kind": "message", "body": "hello"})
	body := f.expect(http.MethodGet, "/api/v1/chatter_messages?table=crm&record="+record, nil, http.StatusOK)
	if !strings.Contains(string(body), "hello") {
		t.Errorf("chatter feed lacks the posted message: %s", body)
	}

	// Settings: write back exactly what is there, so the dev workspace is unchanged.
	for _, path := range []string{"/api/v1/settings/tax", "/api/v1/settings/integrations/osm", "/api/v1/settings/views/crm/fields", "/api/v1/settings/views/crm/graph"} {
		current := decode(t, f.expect(http.MethodGet, path, nil, http.StatusOK))
		f.expect(http.MethodPut, path, current, http.StatusNoContent)
	}
	f.expect(http.MethodPut, "/api/v1/settings/tax", map[string]any{"price_mode": "bogus"}, http.StatusBadRequest)

	// Module reload: a re-validation no-op for Go modules, logged as an operation.
	f.expect(http.MethodPost, "/api/v1/modules/sale/reload", nil, http.StatusOK)
	f.expect(http.MethodGet, "/api/v1/modules/nope", nil, http.StatusNotFound)
}

// TestApp_ProductFlow: product creation needs no description, references
// come from the sequence while the warehouse setting is on (the default) and
// can't change, are typed while it's off; a line created from a product
// inherits its taxes (product_tax).
func TestApp_ProductFlow(t *testing.T) {
	f := newFlow(t)
	str := func(body []byte, key string) string {
		t.Helper()
		v, _ := decode(t, body)[key].(string)
		return v
	}
	// The suite may run against the live dev DB: leave the workspace's
	// product sequence as found, so its next real product isn't numbered
	// after these test ones.
	ctx := context.Background()
	var lastBefore *int
	_ = f.a.db.DB.QueryRow(ctx, `SELECT last FROM warehouse_sequence WHERE tenant_id = $1 AND kind = 'product'`, auth.DevTenantID).Scan(&lastBefore)
	t.Cleanup(func() {
		if lastBefore == nil {
			_, _ = f.a.db.DB.Exec(ctx, `DELETE FROM warehouse_sequence WHERE tenant_id = $1 AND kind = 'product'`, auth.DevTenantID)
		} else {
			_, _ = f.a.db.DB.Exec(ctx, `UPDATE warehouse_sequence SET last = $2 WHERE tenant_id = $1 AND kind = 'product'`, auth.DevTenantID, *lastBefore)
		}
	})
	settingsBody := f.expect(http.MethodGet, "/api/v1/settings/warehouse", nil, http.StatusOK)
	auto, _ := decode(t, settingsBody)["auto_reference"].(bool)
	t.Cleanup(func() { f.do(http.MethodPut, "/api/v1/settings/warehouse", map[string]any{"auto_reference": auto}) })
	f.expect(http.MethodPut, "/api/v1/settings/warehouse", map[string]any{"auto_reference": true}, http.StatusOK)

	// No description, no reference: both optional; the reference is the sequence's.
	p1 := f.createAt("/api/v1/product", "product", map[string]any{"name": "Flow desk", "unit_price": 100, "reference": "TYPED"})
	p2 := f.createAt("/api/v1/product", "product", map[string]any{"name": "Flow chair", "unit_price": 50})
	r1 := str(f.expect(http.MethodGet, "/api/v1/product/"+p1, nil, http.StatusOK), "reference")
	r2 := str(f.expect(http.MethodGet, "/api/v1/product/"+p2, nil, http.StatusOK), "reference")
	if !strings.HasPrefix(r1, "PRD-") || r1 == r2 || r1 == "TYPED" {
		t.Fatalf("auto references = %q, %q, want two distinct PRD-NNNNN", r1, r2)
	}
	f.expect(http.MethodPut, "/api/v1/product/"+p1, map[string]any{"name": "Flow desk", "reference": "CHANGED", "unit_price": 100, "description": ""}, http.StatusOK)
	if got := str(f.expect(http.MethodGet, "/api/v1/product/"+p1, nil, http.StatusOK), "reference"); got != r1 {
		t.Errorf("auto reference after an edit = %q, want %q", got, r1)
	}

	// Manual mode: the typed reference stands, and can be edited.
	f.expect(http.MethodPut, "/api/v1/settings/warehouse", map[string]any{"auto_reference": false}, http.StatusOK)
	if got, _ := decode(t, f.expect(http.MethodGet, "/api/v1/settings/warehouse", nil, http.StatusOK))["auto_reference"].(bool); got {
		t.Fatal("auto_reference still on after turning it off")
	}
	p3 := f.createAt("/api/v1/product", "product", map[string]any{"name": "Flow lamp", "unit_price": 10, "reference": "LAMP-1"})
	f.expect(http.MethodPut, "/api/v1/product/"+p3, map[string]any{"name": "Flow lamp", "reference": "LAMP-2", "unit_price": 10, "description": ""}, http.StatusOK)
	if got := str(f.expect(http.MethodGet, "/api/v1/product/"+p3, nil, http.StatusOK), "reference"); got != "LAMP-2" {
		t.Errorf("manual reference = %q, want LAMP-2", got)
	}
	f.expect(http.MethodPut, "/api/v1/settings/warehouse", map[string]any{}, http.StatusBadRequest)

	// Taxes: a 20% VAT and a fixed 1.5 levy on the desk.
	vat := f.create("sale_tax", map[string]any{"name": "Flow VAT 20%", "kind": "percentage", "rate": 0.2})
	levy := f.create("sale_tax", map[string]any{"name": "Flow levy", "kind": "fixed", "amount": 1.5})
	f.create("product_tax", map[string]any{"product_id": p1, "sale_tax_id": vat})
	f.create("product_tax", map[string]any{"product_id": p1, "sale_tax_id": levy})
	variant := f.create("product_variant", map[string]any{"product_id": p1})

	taxIncluded := strings.Contains(string(f.expect(http.MethodGet, "/api/v1/settings/tax", nil, http.StatusOK)), "tax_included")
	invoice := f.create("invoice", map[string]any{"customer_name": "Flow"})
	line := f.create("sale_line", map[string]any{"invoice_id": invoice, "variant_id": variant, "quantity": 2})
	t.Cleanup(func() { _, _ = f.a.db.DB.Exec(ctx, `DELETE FROM sale_line_tax WHERE sale_line_id = $1`, line) })
	links := string(f.expect(http.MethodGet, "/api/v1/sale_line_tax?filter[sale_line_id]="+line, nil, http.StatusOK))
	if !strings.Contains(links, vat) || !strings.Contains(links, levy) {
		t.Errorf("line tax links = %s, want the product's two taxes", links)
	}
	// 2 × 100 + 20% + 1.5 = 241.5 on top of the price, or 200 tax included.
	want := 241.5
	if taxIncluded {
		want = 200
	}
	if got := number(t, f.expect(http.MethodGet, "/api/v1/sale_line/"+line, nil, http.StatusOK), "total"); math.Abs(got-want) > 1e-9 {
		t.Errorf("line total = %v, want %v", got, want)
	}
	// Switching the line to another product swaps its taxes for that
	// product's (here none); a plain quantity edit keeps them.
	chairVariant := f.create("product_variant", map[string]any{"product_id": p2})
	f.expect(http.MethodPut, "/api/v1/sale_line/"+line, map[string]any{"quantity": 3}, http.StatusOK)
	if got := string(f.expect(http.MethodGet, "/api/v1/sale_line_tax?filter[sale_line_id]="+line, nil, http.StatusOK)); !strings.Contains(got, vat) {
		t.Errorf("a quantity edit dropped the line's taxes: %s", got)
	}
	f.expect(http.MethodPut, "/api/v1/sale_line/"+line, map[string]any{"variant_id": chairVariant}, http.StatusOK)
	if got := string(f.expect(http.MethodGet, "/api/v1/sale_line_tax?filter[sale_line_id]="+line, nil, http.StatusOK)); strings.Contains(got, vat) || strings.Contains(got, levy) {
		t.Errorf("another product kept the old taxes: %s", got)
	}
	// 3 × 50, untaxed.
	if got := number(t, f.expect(http.MethodGet, "/api/v1/sale_line/"+line, nil, http.StatusOK), "total"); math.Abs(got-150) > 1e-9 {
		t.Errorf("line total after switching product = %v, want 150", got)
	}
	f.expect(http.MethodPut, "/api/v1/sale_line/"+line, map[string]any{"variant_id": invoice}, http.StatusUnprocessableEntity)

	// A quote line has no tax links: its rate is the product's percentage taxes.
	quote := f.create("quote", map[string]any{"customer_name": "Flow"})
	quoteLine := f.create("quote_line", map[string]any{"quote_id": quote, "variant_id": variant, "quantity": 1})
	if got := number(t, f.expect(http.MethodGet, "/api/v1/quote_line/"+quoteLine, nil, http.StatusOK), "tax_rate"); math.Abs(got-0.2) > 1e-9 {
		t.Errorf("quote line tax_rate = %v, want 0.2", got)
	}
}

// TestApp_EventSettings: the Event app's reminder and waiting-list settings —
// defaults, a round trip, and every refusal.
func TestApp_EventSettings(t *testing.T) {
	f := newFlow(t)
	before := f.expect(http.MethodGet, "/api/v1/settings/events", nil, http.StatusOK)
	t.Cleanup(func() { f.do(http.MethodPut, "/api/v1/settings/events", json.RawMessage(before)) })

	got := decode(t, f.expect(http.MethodPut, "/api/v1/settings/events", map[string]any{"reminder_hours": 48, "waitlist_claim_hours": 6}, http.StatusOK))
	if got["reminder_hours"] != 48.0 || got["waitlist_claim_hours"] != 6.0 {
		t.Errorf("saved = %v", got)
	}
	got = decode(t, f.expect(http.MethodGet, "/api/v1/settings/events", nil, http.StatusOK))
	if got["reminder_hours"] != 48.0 || got["waitlist_claim_hours"] != 6.0 {
		t.Errorf("read back = %v", got)
	}
	// An absent claim window takes the default (12 h).
	got = decode(t, f.expect(http.MethodPut, "/api/v1/settings/events", map[string]any{"reminder_hours": 0}, http.StatusOK))
	if got["waitlist_claim_hours"] != 12.0 {
		t.Errorf("default claim window = %v, want 12", got["waitlist_claim_hours"])
	}
	for _, body := range []any{
		map[string]any{"reminder_hours": -1},
		map[string]any{"reminder_hours": 721},
		map[string]any{"reminder_hours": 24, "waitlist_claim_hours": 169},
		"not an object",
	} {
		f.expect(http.MethodPut, "/api/v1/settings/events", body, http.StatusBadRequest)
	}
}

// TestApp_DevSeedRoutes: the full demo seed's routes up to the point where a
// real (100 000-row) seed would start — the group list, refusals, and the
// development-only gate.
func TestApp_DevSeedRoutes(t *testing.T) {
	c := buildApp(t)
	code, body := c.do(http.MethodGet, "/api/v1/dev_seed", nil)
	if code != http.StatusOK {
		t.Fatalf("groups: %d %s", code, body)
	}
	groups, _ := decode(t, body)["data"].([]any)
	keys := map[string]bool{}
	for _, g := range groups {
		keys[g.(map[string]any)["key"].(string)] = true
	}
	for _, want := range []string{"base", "products", "contacts", "quotes", "invoices"} {
		if !keys[want] {
			t.Errorf("groups %v lack %q", keys, want)
		}
	}
	if code, body := c.do(http.MethodPost, "/api/v1/dev_seed", map[string]any{"groups": []string{"no-such-group"}}); code != http.StatusBadRequest {
		t.Errorf("unknown group = %d %s, want 400", code, body)
	}
	if code, _ := c.do(http.MethodPost, "/api/v1/dev_seed", "not an object"); code != http.StatusBadRequest {
		t.Errorf("malformed body = %d, want 400", code)
	}

	prod := buildAppWith(t, func(cfg *types.Config) { cfg.Environment = "production" })
	if code, _ := prod.do(http.MethodPost, "/api/v1/dev_seed", map[string]any{}); code != http.StatusForbidden {
		t.Errorf("seed outside development = %d, want 403", code)
	}
}

// TestApp_SaleAndProductRefusals: every route the sale workflow and the
// product reference middlewares sit on refuses malformed input and unknown
// documents cleanly.
func TestApp_SaleAndProductRefusals(t *testing.T) {
	f := newFlow(t)
	unknown := uuid.NewString()
	tests := []struct {
		method, path string
		body         any
		want         int
	}{
		{http.MethodPost, "/api/v1/quote", "not an object", http.StatusBadRequest},
		{http.MethodPost, "/api/v1/invoice", "not an object", http.StatusBadRequest},
		{http.MethodPut, "/api/v1/quote/" + unknown, map[string]any{"status": "draft"}, http.StatusNotFound},
		{http.MethodPut, "/api/v1/quote/not-a-uuid", map[string]any{}, http.StatusBadRequest},
		{http.MethodPost, "/api/v1/quote/" + unknown + "/confirm", nil, http.StatusNotFound},
		{http.MethodPost, "/api/v1/quote/" + unknown + "/send", nil, http.StatusNotFound},
		{http.MethodPost, "/api/v1/quote/" + unknown + "/accept", nil, http.StatusNotFound},
		{http.MethodPost, "/api/v1/quote/not-a-uuid/accept", nil, http.StatusBadRequest},
		{http.MethodPost, "/api/v1/quote/not-a-uuid/send", nil, http.StatusBadRequest},
		{http.MethodPost, "/api/v1/invoice/" + unknown + "/confirm", nil, http.StatusNotFound},
		{http.MethodPost, "/api/v1/invoice/" + unknown + "/send", nil, http.StatusNotFound},
		{http.MethodPost, "/api/v1/product", "not an object", http.StatusBadRequest},
		{http.MethodPut, "/api/v1/product/" + unknown, map[string]any{"name": "x"}, http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			f.expect(tc.method, tc.path, tc.body, tc.want)
		})
	}

	// A malformed body on an existing quote and product.
	quote := f.create("quote", map[string]any{"customer_name": "Refusals"})
	f.expect(http.MethodPut, "/api/v1/quote/"+quote, "not an object", http.StatusBadRequest)
	f.expect(http.MethodPut, "/api/v1/settings/warehouse", map[string]any{"auto_reference": true}, http.StatusOK)
	product := f.createAt("/api/v1/product", "product", map[string]any{"name": "Refusals", "unit_price": 1})
	f.expect(http.MethodPut, "/api/v1/product/"+product, "not an object", http.StatusBadRequest)
}
