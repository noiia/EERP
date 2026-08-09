package sale

import "testing"

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
