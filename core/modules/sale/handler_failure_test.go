package sale

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/company"
	"core/internal/settings"
	"core/internal/testdb"
	"core/modules/warehouse"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func saleCall(t *testing.T, h echo.HandlerFunc, id, body string) int {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(echo.PathValues{{Name: "id", Value: id}})
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec.Code
}

// The invoice/quote line overrides and the workflow steps refuse what they
// can't parse, and a database that can't be reached is never a 2xx.
func TestSaleHandlers_RefusalsAndDatabaseDown(t *testing.T) {
	if err := (&saleModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	db := testdb.Closed(t).DB
	lines := NewHandler(
		orm.MustRepo[SaleLine](db), orm.MustRepo[Invoice](db), orm.MustRepo[warehouse.ProductVariant](db),
		orm.MustRepo[warehouse.Product](db), orm.MustRepo[SaleTax](db), orm.MustRepo[SaleLineTax](db),
		orm.MustRepo[ProductTax](db), orm.MustRepo[warehouse.ProductUoms](db), settings.NewRepository(db), company.NewRepository(db),
	)
	quotes := NewQuoteHandler(
		orm.MustRepo[QuoteLine](db), orm.MustRepo[Quote](db), orm.MustRepo[warehouse.ProductVariant](db),
		orm.MustRepo[warehouse.Product](db), orm.MustRepo[ProductTax](db), orm.MustRepo[SaleTax](db), orm.MustRepo[warehouse.ProductUoms](db),
	)
	flow := NewWorkflowHandler(db, company.NewRepository(db), settings.NewRepository(db), nil)
	id := uuid.NewString()

	cases := []struct {
		name string
		call echo.HandlerFunc
		id   string
		body string
		bad  bool // true: a 4xx refusal; false: a 4xx/5xx from the unreachable database
	}{
		{"invoice line: malformed", lines.Create, "", `{`, true},
		{"invoice line: database down", lines.Create, "", `{"invoice_id":"` + id + `","name":"A","quantity":1,"unit_price":5}`, false},
		{"update invoice line: bad id", lines.Update, "nope", `{}`, true},
		{"update invoice line: database down", lines.Update, id, `{}`, false},
		{"delete invoice line: bad id", lines.Delete, "nope", "", true},
		{"delete invoice line: database down", lines.Delete, id, "", false},
		{"line tax: malformed", lines.CreateLineTax, "", `{`, true},
		{"line tax: database down", lines.CreateLineTax, "", `{"sale_line_id":"` + id + `","sale_tax_id":"` + id + `"}`, false},
		{"delete line tax: bad id", lines.DeleteLineTax, "nope", "", true},
		{"delete line tax: database down", lines.DeleteLineTax, id, "", false},
		{"quote line: malformed", quotes.Create, "", `{`, true},
		{"quote line: database down", quotes.Create, "", `{"quote_id":"` + id + `","name":"A","quantity":1}`, false},
		{"update quote line: bad id", quotes.Update, "nope", `{}`, true},
		{"update quote line: database down", quotes.Update, id, `{}`, false},
		{"delete quote line: bad id", quotes.Delete, "nope", "", true},
		{"delete quote line: database down", quotes.Delete, id, "", false},
		{"confirm quote: bad id", flow.ConfirmQuote, "nope", "", true},
		{"confirm invoice: database down", flow.ConfirmInvoice, id, "", false},
		{"send quote: bad id", flow.SendQuote, "nope", "", true},
		{"send invoice: database down", flow.SendInvoice, id, "", false},
		{"accept quote: bad id", flow.AcceptQuote, "nope", "", true},
		{"accept quote: database down", flow.AcceptQuote, id, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code := saleCall(t, tc.call, tc.id, tc.body)
			if tc.bad && code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", code)
			}
			if code < 400 {
				t.Fatalf("status = %d, want an error", code)
			}
		})
	}
}
