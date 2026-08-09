package warehouse

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// Regression: Handler.Create binds the request body straight onto
// ProductVariant via c.Bind (encoding/json). Without an explicit `json`
// struct tag matching each `db` tag, "product_id" in the request never
// matches the Go field ProductID (case-insensitive matching doesn't ignore
// underscores) — the field silently stays uuid.Nil, and Create rejects a
// perfectly valid request with "product_id must reference an existing
// product." This test exercises the exact same encoding/json path Bind
// uses, not just the struct's shape.
func TestProductVariant_JSONUnmarshalsProductID(t *testing.T) {
	productID := uuid.New()
	body := []byte(`{"product_id":"` + productID.String() + `","name":"Red / XL"}`)

	var variant ProductVariant
	if err := json.Unmarshal(body, &variant); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if variant.ProductID != productID {
		t.Errorf("ProductID = %v, want %v", variant.ProductID, productID)
	}
	if variant.Name != "Red / XL" {
		t.Errorf("Name = %q, want %q", variant.Name, "Red / XL")
	}
}

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
