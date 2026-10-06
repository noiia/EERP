// Package payment is the provider registry behind online payment (Event v2,
// docs/adr/ADR-028-payment-providers.md). A provider module (payment_stripe)
// registers itself at init; a caller asks Available for a provider that is
// both active (its module, live App Store state) and configured for the
// tenant. No provider available simply means "pay later" — never an error.
package payment

import (
	"context"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// CheckoutRequest is one hosted payment page for Amount (minor units, e.g.
// cents) in Currency (ISO 4217). Reference comes back in the webhook.
type CheckoutRequest struct {
	Reference     string
	Amount        int64
	Currency      string
	Description   string
	CustomerEmail string
	SuccessURL    string
	CancelURL     string
	ExpiresAt     time.Time
}

// Checkout is the created payment page.
type Checkout struct {
	ID  string
	URL string
}

// WebhookEvent is a provider notification, already authenticated.
type WebhookEvent struct {
	Reference string
	Paid      bool // the payment succeeded
	Expired   bool // the payment page expired unpaid
}

// Provider is one payment service.
type Provider interface {
	Configured(ctx context.Context, tenant uuid.UUID) (bool, error)
	CreateCheckout(ctx context.Context, tenant uuid.UUID, req CheckoutRequest) (Checkout, error)
	// ParseWebhook authenticates (signature) and decodes a notification; an
	// event the caller needn't act on comes back with neither Paid nor Expired.
	ParseWebhook(ctx context.Context, tenant uuid.UUID, body []byte, header http.Header) (WebhookEvent, error)
}

// Registered is a provider and the module (= its name) that registered it.
type Registered struct {
	Name     string
	Provider Provider
}

var (
	mu        sync.RWMutex
	providers []Registered
	isActive  = func(string) bool { return true }
)

// Register adds a provider under its module's name; call from init().
func Register(module string, p Provider) {
	mu.Lock()
	defer mu.Unlock()
	providers = append(providers, Registered{Name: module, Provider: p})
}

// SetActiveCheck wires the live module state (module.Registry.IsActive) at boot.
func SetActiveCheck(f func(module string) bool) {
	mu.Lock()
	defer mu.Unlock()
	isActive = f
}

// Available returns the first registered provider whose module is active and
// which is configured for tenant.
func Available(ctx context.Context, tenant uuid.UUID) (Registered, bool, error) {
	mu.RLock()
	list, active := append([]Registered(nil), providers...), isActive
	mu.RUnlock()
	for _, r := range list {
		if !active(r.Name) {
			continue
		}
		ok, err := r.Provider.Configured(ctx, tenant)
		if err != nil {
			return Registered{}, false, err
		}
		if ok {
			return r, true, nil
		}
	}
	return Registered{}, false, nil
}

// Lookup finds a provider by module name (a webhook route names its provider).
func Lookup(module string) (Provider, bool) {
	mu.RLock()
	defer mu.RUnlock()
	for _, r := range providers {
		if r.Name == module {
			return r.Provider, true
		}
	}
	return nil, false
}

// zeroDecimal are the ISO 4217 currencies without a minor unit.
var zeroDecimal = map[string]bool{"BIF": true, "CLP": true, "DJF": true, "GNF": true, "JPY": true, "KMF": true,
	"KRW": true, "MGA": true, "PYG": true, "RWF": true, "UGX": true, "VND": true, "VUV": true, "XAF": true, "XOF": true, "XPF": true}

// MinorUnits converts an amount to the currency's minor unit (cents), rounded.
func MinorUnits(amount float64, currency string) int64 {
	if zeroDecimal[strings.ToUpper(currency)] {
		return int64(math.Round(amount))
	}
	return int64(math.Round(amount * 100))
}

func reset() { // tests
	mu.Lock()
	defer mu.Unlock()
	providers, isActive = nil, func(string) bool { return true }
}
