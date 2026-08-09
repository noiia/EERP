package warehouse

import "testing"

func TestDefaultVariantName(t *testing.T) {
	tests := []struct {
		name, in, productName, want string
	}{
		{"keeps an explicit name", "Red / XL", "T-Shirt", "Red / XL"},
		{"defaults to the product's name when blank", "", "T-Shirt", "T-Shirt"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := defaultVariantName(tt.in, tt.productName); got != tt.want {
				t.Errorf("defaultVariantName(%q, %q) = %q, want %q", tt.in, tt.productName, got, tt.want)
			}
		})
	}
}
