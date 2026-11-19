package website

import (
	"context"
	"testing"

	"core/orm/access"
)

func TestActiveOnly(t *testing.T) {
	tests := []struct {
		name       string
		active     bool
		wantOK     bool
		wantCalled bool
	}{
		{"inactive is not published and never reaches the inner resolver", false, false, false},
		{"active delegates", true, true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			inner := func(context.Context, string) (access.PublicScope, bool, error) {
				called = true
				return access.PublicScope{}, true, nil
			}
			_, ok, err := ActiveOnly(func(string) bool { return tt.active }, inner)(context.Background(), "product")
			if err != nil || ok != tt.wantOK || called != tt.wantCalled {
				t.Errorf("ok=%v called=%v err=%v, want ok=%v called=%v", ok, called, err, tt.wantOK, tt.wantCalled)
			}
		})
	}
}
