package payment

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

type fakeProvider struct{ configured bool }

func (f fakeProvider) Configured(context.Context, uuid.UUID) (bool, error) { return f.configured, nil }
func (fakeProvider) CreateCheckout(context.Context, uuid.UUID, CheckoutRequest) (Checkout, error) {
	return Checkout{}, nil
}
func (fakeProvider) ParseWebhook(context.Context, uuid.UUID, []byte, http.Header) (WebhookEvent, error) {
	return WebhookEvent{}, nil
}

func TestAvailable(t *testing.T) {
	t.Cleanup(reset)
	ctx, tenant := context.Background(), uuid.New()
	if _, ok, _ := Available(ctx, tenant); ok {
		t.Fatal("a provider is available with none registered")
	}
	Register("off_module", fakeProvider{configured: true})
	Register("unconfigured", fakeProvider{configured: false})
	active := map[string]bool{"unconfigured": true}
	SetActiveCheck(func(name string) bool { return active[name] })
	if _, ok, _ := Available(ctx, tenant); ok {
		t.Fatal("inactive or unconfigured providers count as available")
	}
	active["off_module"] = true
	p, ok, err := Available(ctx, tenant)
	if err != nil || !ok || p.Name != "off_module" {
		t.Fatalf("Available = %+v %v %v, want the active, configured provider", p, ok, err)
	}
	if got, ok := Lookup("unconfigured"); !ok || got == nil {
		t.Error("Lookup by name failed")
	}
}

func TestMinorUnits(t *testing.T) {
	for _, tt := range []struct {
		amount   float64
		currency string
		want     int64
	}{{30, "EUR", 3000}, {12.345, "usd", 1235}, {1500, "JPY", 1500}} {
		if got := MinorUnits(tt.amount, tt.currency); got != tt.want {
			t.Errorf("MinorUnits(%v, %s) = %d, want %d", tt.amount, tt.currency, got, tt.want)
		}
	}
}
