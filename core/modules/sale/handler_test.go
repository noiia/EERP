package sale

import (
	"encoding/json"
	"testing"

	"core/modules/warehouse"

	"github.com/google/uuid"
)

// resolveUnitPrice: a variant's own UnitPrice override wins over the
// product's when set; a nil override falls back to the product's price —
// the "inherit by default" behavior every variant had before overrides
// existed.
func TestResolveUnitPrice(t *testing.T) {
	product := warehouse.Product{UnitPrice: 10}
	override := 15.0

	tests := []struct {
		name    string
		variant warehouse.ProductVariant
		want    float64
	}{
		{"no override falls back to product price", warehouse.ProductVariant{}, 10},
		{"override wins over product price", warehouse.ProductVariant{UnitPrice: &override}, 15},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveUnitPrice(product, tt.variant); got != tt.want {
				t.Errorf("resolveUnitPrice() = %v, want %v", got, tt.want)
			}
		})
	}
}

// Regression: Handler.Create/Update bind the request body straight onto
// SaleLine via c.Bind (encoding/json). Without an explicit `json` struct
// tag matching each `db` tag, snake_case keys like "variant_id"/
// "invoice_id" never match their Go fields (case-insensitive matching
// doesn't ignore underscores) — they'd silently stay uuid.Nil and
// snapshotFromVariant would reject a perfectly valid line. This exercises
// the exact same encoding/json path Bind uses, not just the struct's shape.
func TestSaleLine_JSONUnmarshalsIDFields(t *testing.T) {
	invoiceID, variantID := uuid.New(), uuid.New()
	body := []byte(`{"invoice_id":"` + invoiceID.String() + `","variant_id":"` + variantID.String() + `","quantity":3}`)

	var line SaleLine
	if err := json.Unmarshal(body, &line); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if line.InvoiceID != invoiceID {
		t.Errorf("InvoiceID = %v, want %v", line.InvoiceID, invoiceID)
	}
	if line.VariantID != variantID {
		t.Errorf("VariantID = %v, want %v", line.VariantID, variantID)
	}
	if line.Quantity != 3 {
		t.Errorf("Quantity = %v, want 3", line.Quantity)
	}
}

func TestResolveTaxRate(t *testing.T) {
	product := warehouse.Product{TaxRate: 0.2}
	override := 0.1

	tests := []struct {
		name    string
		variant warehouse.ProductVariant
		want    float64
	}{
		{"no override falls back to product tax rate", warehouse.ProductVariant{}, 0.2},
		{"override wins over product tax rate", warehouse.ProductVariant{TaxRate: &override}, 0.1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveTaxRate(product, tt.variant); got != tt.want {
				t.Errorf("resolveTaxRate() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSumLines(t *testing.T) {
	tests := []struct {
		name                             string
		lines                            []SaleLine
		wantSubtotal, wantTax, wantTotal float64
	}{
		{
			name:  "no lines",
			lines: nil,
		},
		{
			name: "single line, single tax rate",
			lines: []SaleLine{
				{Quantity: 2, UnitPrice: 50, TaxRate: 0.2}, // 100 HT, 20 tax
			},
			wantSubtotal: 100,
			wantTax:      20,
			wantTotal:    120,
		},
		{
			name: "mixed tax rates per product sum independently",
			lines: []SaleLine{
				{Quantity: 1, UnitPrice: 100, TaxRate: 0.2}, // 100 HT, 20 tax
				{Quantity: 3, UnitPrice: 10, TaxRate: 0.1},  // 30 HT, 3 tax
			},
			wantSubtotal: 130,
			wantTax:      23,
			wantTotal:    153,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			subtotal, tax, total := sumLines(tt.lines)
			if subtotal != tt.wantSubtotal || tax != tt.wantTax || total != tt.wantTotal {
				t.Errorf("sumLines() = (%v, %v, %v), want (%v, %v, %v)",
					subtotal, tax, total,
					tt.wantSubtotal, tt.wantTax, tt.wantTotal)
			}
		})
	}
}

// Regression: QuoteHandler.Create/Update bind the request body straight onto
// QuoteLine via c.Bind — same underscore-insensitivity pitfall as SaleLine,
// see TestSaleLine_JSONUnmarshalsIDFields above.
func TestQuoteLine_JSONUnmarshalsIDFields(t *testing.T) {
	quoteID, variantID := uuid.New(), uuid.New()
	body := []byte(`{"quote_id":"` + quoteID.String() + `","variant_id":"` + variantID.String() + `","quantity":3}`)

	var line QuoteLine
	if err := json.Unmarshal(body, &line); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if line.QuoteID != quoteID {
		t.Errorf("QuoteID = %v, want %v", line.QuoteID, quoteID)
	}
	if line.VariantID != variantID {
		t.Errorf("VariantID = %v, want %v", line.VariantID, variantID)
	}
	if line.Quantity != 3 {
		t.Errorf("Quantity = %v, want 3", line.Quantity)
	}
}

func TestSumQuoteLines(t *testing.T) {
	subtotal, tax, total := sumQuoteLines([]QuoteLine{
		{Quantity: 2, UnitPrice: 50, TaxRate: 0.2}, // 100 HT, 20 tax
	})
	if subtotal != 100 || tax != 20 || total != 120 {
		t.Errorf("sumQuoteLines() = (%v, %v, %v), want (100, 20, 120)", subtotal, tax, total)
	}
}
