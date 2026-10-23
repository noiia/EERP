package sale

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/testdb"
	_ "core/modules/settings"
	"core/modules/warehouse"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func serveAs(t *testing.T, h echo.HandlerFunc, method, body string, identity auth.Identity, id string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), identity))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(append(c.PathValues(), echo.PathValue{Name: "id", Value: id}))
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec
}

// The invoice/quote line overrides read and write through typed
// repositories, which — unlike the generic CRUD layer — don't scope by
// tenant. A caller aiming one at another workspace's row (an id in the path
// or the body) must be refused and leave that row untouched; its own rows
// keep working.
func TestLineOverrides_AreTenantScoped(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "settings", "warehouse", "sale")
	owner, intruder := uuid.New(), uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{
			"sale_line_tax", "sale_line", "invoice", "quote_line", "quote",
			"sale_tax", "product_variant", "product", "app_settings",
		} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = ANY($1)`, []uuid.UUID{owner, intruder})
		}
	})

	lines := orm.MustRepo[SaleLine](app.DB)
	invoices := orm.MustRepo[Invoice](app.DB)
	variants := orm.MustRepo[warehouse.ProductVariant](app.DB)
	products := orm.MustRepo[warehouse.Product](app.DB)
	taxes := orm.MustRepo[SaleTax](app.DB)
	lineTaxes := orm.MustRepo[SaleLineTax](app.DB)
	quoteLines := orm.MustRepo[QuoteLine](app.DB)
	quotes := orm.MustRepo[Quote](app.DB)
	// companies: only the tax price mode needs it, reached past the guards.
	productTaxLinks := orm.MustRepo[ProductTax](app.DB)
	uoms := orm.MustRepo[warehouse.ProductUoms](app.DB)
	h := NewHandler(lines, invoices, variants, products, taxes, lineTaxes, productTaxLinks, uoms, settings.NewRepository(app.DB), nil)
	qh := NewQuoteHandler(quoteLines, quotes, variants, products, productTaxLinks, taxes, uoms)

	in := func(tenant uuid.UUID) model.BaseModel { return model.BaseModel{TenantID: tenant} }
	product, err := products.Create(ctx, warehouse.Product{BaseModel: in(owner), Name: "Desk", UnitPrice: 100})
	must(t, err)
	variant, err := variants.Create(ctx, warehouse.ProductVariant{BaseModel: in(owner), ProductID: product.ID, Name: "Oak"})
	must(t, err)
	total := 100.0
	invoice, err := invoices.Create(ctx, Invoice{BaseModel: in(owner), Number: "INV-1", Status: "draft", Total: &total})
	must(t, err)
	line, err := lines.Create(ctx, SaleLine{
		BaseModel: in(owner), InvoiceID: invoice.ID, VariantID: variant.ID, VariantName: "Oak",
		Quantity: 1, UnitPrice: 100, Subtotal: 100, Total: 100,
	})
	must(t, err)
	tax, err := taxes.Create(ctx, SaleTax{BaseModel: in(owner), Name: "VAT", Kind: "percentage", Rate: 0.2})
	must(t, err)
	link, err := lineTaxes.Create(ctx, SaleLineTax{BaseModel: in(owner), SaleLineID: line.ID, SaleTaxID: tax.ID})
	must(t, err)
	quote, err := quotes.Create(ctx, Quote{BaseModel: in(owner), Status: "draft", Total: &total})
	must(t, err)
	quoteLine, err := quoteLines.Create(ctx, QuoteLine{
		BaseModel: in(owner), QuoteID: quote.ID, VariantID: variant.ID, VariantName: "Oak", Quantity: 1, UnitPrice: 100,
	})
	must(t, err)
	// The intruder's own quote: a line on it may still not use the owner's variant.
	theirQuote, err := quotes.Create(ctx, Quote{BaseModel: in(intruder), Status: "draft"})
	must(t, err)

	them := auth.Identity{TenantID: intruder, UserID: uuid.New()}
	ids := func(pairs ...string) string {
		var b strings.Builder
		b.WriteString("{")
		for i := 0; i < len(pairs); i += 2 {
			if i > 0 {
				b.WriteString(",")
			}
			b.WriteString(`"` + pairs[i] + `":"` + pairs[i+1] + `"`)
		}
		b.WriteString(`,"quantity":5}`)
		return b.String()
	}
	tests := []struct {
		name string
		rec  func() *httptest.ResponseRecorder
		want int
	}{
		{"POST invoice line onto their invoice", func() *httptest.ResponseRecorder {
			return serveAs(t, h.Create, http.MethodPost, ids("invoice_id", invoice.ID.String(), "variant_id", variant.ID.String()), them, "")
		}, http.StatusNotFound},
		{"PUT their invoice line", func() *httptest.ResponseRecorder {
			return serveAs(t, h.Update, http.MethodPut, `{"quantity":99}`, them, line.ID.String())
		}, http.StatusNotFound},
		{"DELETE their invoice line", func() *httptest.ResponseRecorder {
			return serveAs(t, h.Delete, http.MethodDelete, "", them, line.ID.String())
		}, http.StatusNotFound},
		{"POST tax link onto their line", func() *httptest.ResponseRecorder {
			return serveAs(t, h.CreateLineTax, http.MethodPost, `{"sale_line_id":"`+line.ID.String()+`","sale_tax_id":"`+tax.ID.String()+`"}`, them, "")
		}, http.StatusNotFound},
		{"DELETE their tax link", func() *httptest.ResponseRecorder {
			return serveAs(t, h.DeleteLineTax, http.MethodDelete, "", them, link.ID.String())
		}, http.StatusNotFound},
		{"POST quote line onto their quote", func() *httptest.ResponseRecorder {
			return serveAs(t, qh.Create, http.MethodPost, ids("quote_id", quote.ID.String(), "variant_id", variant.ID.String()), them, "")
		}, http.StatusNotFound},
		{"PUT their quote line", func() *httptest.ResponseRecorder {
			return serveAs(t, qh.Update, http.MethodPut, `{"quantity":99}`, them, quoteLine.ID.String())
		}, http.StatusNotFound},
		{"DELETE their quote line", func() *httptest.ResponseRecorder {
			return serveAs(t, qh.Delete, http.MethodDelete, "", them, quoteLine.ID.String())
		}, http.StatusNotFound},
		{"POST own quote line using their variant", func() *httptest.ResponseRecorder {
			return serveAs(t, qh.Create, http.MethodPost, ids("quote_id", theirQuote.ID.String(), "variant_id", variant.ID.String()), them, "")
		}, http.StatusUnprocessableEntity},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if rec := tt.rec(); rec.Code != tt.want {
				t.Errorf("from another tenant = %d %s, want %d", rec.Code, rec.Body.String(), tt.want)
			}
		})
	}

	// The owner's rows are exactly as they were.
	gotLine, err := findOwned(ctx, lines, line.ID, owner)
	must(t, err)
	if gotLine.Quantity != 1 || gotLine.Total != 100 {
		t.Errorf("invoice line changed: %+v", gotLine)
	}
	if _, err := findOwned(ctx, lineTaxes, link.ID, owner); err != nil {
		t.Errorf("tax link was deleted: %v", err)
	}
	gotQuoteLine, err := findOwned(ctx, quoteLines, quoteLine.ID, owner)
	must(t, err)
	if gotQuoteLine.Quantity != 1 {
		t.Errorf("quote line changed: %+v", gotQuoteLine)
	}
	gotInvoice, err := findOwned(ctx, invoices, invoice.ID, owner)
	must(t, err)
	if gotInvoice.Total == nil || *gotInvoice.Total != 100 {
		t.Errorf("invoice total = %v, want 100", gotInvoice.Total)
	}
	var written int
	must(t, app.DB.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM sale_line WHERE tenant_id = $1) + (SELECT count(*) FROM quote_line WHERE tenant_id = $1)
		 + (SELECT count(*) FROM sale_line_tax WHERE tenant_id = $1)`, intruder).Scan(&written))
	if written != 0 {
		t.Errorf("%d rows written by the intruder", written)
	}

	// The guard doesn't get in the owner's way.
	us := auth.Identity{TenantID: owner, UserID: uuid.New()}
	if rec := serveAs(t, qh.Create, http.MethodPost, ids("quote_id", quote.ID.String(), "variant_id", variant.ID.String()), us, ""); rec.Code != http.StatusCreated {
		t.Fatalf("owner POST quote line = %d %s", rec.Code, rec.Body.String())
	}
	gotQuote, err := findOwned(ctx, quotes, quote.ID, owner)
	must(t, err)
	if gotQuote.Subtotal == nil || *gotQuote.Subtotal != 600 { // 1×100 + 5×100
		t.Errorf("owner quote subtotal = %v, want 600", gotQuote.Subtotal)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
