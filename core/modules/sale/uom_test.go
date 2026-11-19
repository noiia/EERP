package sale

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/company"
	"core/internal/settings"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/company"
	"core/modules/warehouse"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// A line's unit of measure is the one it names, else its product's; the
// line items table's `unit` column prints its symbol (else its name). A unit
// the line names must exist; a product's vanished unit is just dropped.
func TestLineUnit_FollowsTheLineThenTheProduct(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "warehouse", "sale")
	tenant := uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{
			"sale_line_tax", "sale_line", "invoice", "quote_line", "quote",
			"product_variant", "product", "product_uoms", "app_settings", "company", "users",
		} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})

	uoms := orm.MustRepo[warehouse.ProductUoms](app.DB)
	products := orm.MustRepo[warehouse.Product](app.DB)
	variants := orm.MustRepo[warehouse.ProductVariant](app.DB)
	invoices := orm.MustRepo[Invoice](app.DB)
	quotes := orm.MustRepo[Quote](app.DB)
	h := NewHandler(orm.MustRepo[SaleLine](app.DB), invoices, variants, products, orm.MustRepo[SaleTax](app.DB),
		orm.MustRepo[SaleLineTax](app.DB), orm.MustRepo[ProductTax](app.DB), uoms, settings.NewRepository(app.DB), company.NewRepository(app.DB))
	qh := NewQuoteHandler(orm.MustRepo[QuoteLine](app.DB), quotes, variants, products,
		orm.MustRepo[ProductTax](app.DB), orm.MustRepo[SaleTax](app.DB), uoms)

	in := model.BaseModel{TenantID: tenant}
	kg, err := uoms.Create(ctx, warehouse.ProductUoms{BaseModel: in, Name: "Kilogram", Type: "weight", Symbol: "kg"})
	must(t, err)
	piece, err := uoms.Create(ctx, warehouse.ProductUoms{BaseModel: in, Name: "Piece", Type: "piece"})
	must(t, err)
	sold := func(uom *uuid.UUID) warehouse.ProductVariant {
		product, err := products.Create(ctx, warehouse.Product{BaseModel: in, Name: "Flour", UnitPrice: 2, UomID: uom})
		must(t, err)
		variant, err := variants.Create(ctx, warehouse.ProductVariant{BaseModel: in, ProductID: product.ID, Name: "Flour"})
		must(t, err)
		return variant
	}
	inKg := sold(&kg.ID)
	gone := uuid.New()
	inGoneUnit := sold(&gone)
	invoice, err := invoices.Create(ctx, Invoice{BaseModel: in, Number: "INV-U", Status: "draft"})
	must(t, err)
	quote, err := quotes.Create(ctx, Quote{BaseModel: in, Status: "draft"})
	must(t, err)
	// A real user: pricing a line resolves the tax mode through their active company.
	me := auth.Identity{TenantID: tenant, UserID: uuid.New()}
	if _, err := app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`,
		me.UserID, tenant, me.UserID.String()+"@sale.test"); err != nil {
		t.Fatal(err)
	}

	line := func(parent, parentID string, variant uuid.UUID, uom string) string {
		body := `{"` + parent + `":"` + parentID + `","variant_id":"` + variant.String() + `","quantity":1`
		if uom != "" {
			body += `,"uom_id":"` + uom + `"`
		}
		return body + "}"
	}
	send := func(handler echo.HandlerFunc) func(string) (int, map[string]any) {
		return func(body string) (int, map[string]any) {
			rec := serveAs(t, handler, http.MethodPost, body, me, "")
			var out map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			return rec.Code, out
		}
	}
	invoiceLine, quoteLine := send(h.Create), send(qh.Create)
	tests := []struct {
		name     string
		create   func(body string) (int, map[string]any)
		body     string
		wantCode int
		wantUnit string
		wantUom  string
	}{
		{"no unit on the line: the product's, printed as its symbol", invoiceLine,
			line("invoice_id", invoice.ID.String(), inKg.ID, ""), http.StatusCreated, "kg", kg.ID.String()},
		{"the line's own unit wins, printed as its name without a symbol", invoiceLine,
			line("invoice_id", invoice.ID.String(), inKg.ID, piece.ID.String()), http.StatusCreated, "Piece", piece.ID.String()},
		{"a unit the line names must exist", invoiceLine,
			line("invoice_id", invoice.ID.String(), inKg.ID, uuid.NewString()), http.StatusUnprocessableEntity, "", ""},
		{"a product's vanished unit is dropped, not an error", invoiceLine,
			line("invoice_id", invoice.ID.String(), inGoneUnit.ID, ""), http.StatusCreated, "", ""},
		{"a quote line follows the same rule", quoteLine,
			line("quote_id", quote.ID.String(), inKg.ID, ""), http.StatusCreated, "kg", kg.ID.String()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			code, out := tc.create(tc.body)
			if code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body %v)", code, tc.wantCode, out)
			}
			if code != http.StatusCreated {
				return
			}
			if got, _ := out["unit"].(string); got != tc.wantUnit {
				t.Errorf("unit = %q, want %q", got, tc.wantUnit)
			}
			got, _ := out["uom_id"].(string)
			if got != tc.wantUom {
				t.Errorf("uom_id = %q, want %q", got, tc.wantUom)
			}
		})
	}
}
