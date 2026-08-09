package sale

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

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

func TestSumLines(t *testing.T) {
	tests := []struct {
		name                                              string
		lines                                             []SaleLine
		discount                                          float64
		wantSubtotal, wantTax, wantNetSubtotal, wantTotal float64
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
			wantSubtotal:    100,
			wantTax:         20,
			wantNetSubtotal: 100,
			wantTotal:       120,
		},
		{
			name: "mixed tax rates per product sum independently",
			lines: []SaleLine{
				{Quantity: 1, UnitPrice: 100, TaxRate: 0.2}, // 100 HT, 20 tax
				{Quantity: 3, UnitPrice: 10, TaxRate: 0.1},  // 30 HT, 3 tax
			},
			wantSubtotal:    130,
			wantTax:         23,
			wantNetSubtotal: 130,
			wantTotal:       153,
		},
		{
			name: "discount reduces net subtotal and total but not the taxable base",
			lines: []SaleLine{
				{Quantity: 1, UnitPrice: 100, TaxRate: 0.2},
			},
			discount:        10,
			wantSubtotal:    100,
			wantTax:         20,
			wantNetSubtotal: 90,
			wantTotal:       110,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			subtotal, tax, netSubtotal, total := sumLines(tt.lines, tt.discount)
			if subtotal != tt.wantSubtotal || tax != tt.wantTax || netSubtotal != tt.wantNetSubtotal || total != tt.wantTotal {
				t.Errorf("sumLines() = (%v, %v, %v, %v), want (%v, %v, %v, %v)",
					subtotal, tax, netSubtotal, total,
					tt.wantSubtotal, tt.wantTax, tt.wantNetSubtotal, tt.wantTotal)
			}
		})
	}
}
