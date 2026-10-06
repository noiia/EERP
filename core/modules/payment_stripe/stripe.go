// Package paymentstripe is the Stripe payment provider (ADR-028): Stripe
// Checkout pages over Stripe's REST API (no SDK), webhooks verified with the
// endpoint's signing secret. It counts as connected when this module is active
// (App Store) AND the tenant saved its keys (Settings → Integrations → Stripe).
package paymentstripe

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"core/internal/module"
	"core/internal/payment"

	"github.com/google/uuid"
)

// Name is the module and provider name.
const Name = "payment_stripe"

// SettingsKey holds the tenant's Stripe settings (JSON) in app_settings'
// tenant-wide slot. The keys never leave Go: the settings GET only says
// whether each is set.
const SettingsKey = "integrations.stripe"

// ErrSignature: a webhook whose Stripe-Signature doesn't verify.
var ErrSignature = errors.New("stripe: bad webhook signature")

// signatureTolerance bounds a webhook's age (replay protection).
const signatureTolerance = 5 * time.Minute

// Settings are a tenant's Stripe connection.
type Settings struct {
	Enabled       bool   `json:"enabled"`
	SecretKey     string `json:"secret_key"`
	WebhookSecret string `json:"webhook_secret"`
}

// Store is the app_settings access the provider needs (internal/settings.Repository).
type Store interface {
	Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error)
	Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error
}

// Provider implements payment.Provider.
type Provider struct {
	store   Store
	baseURL string
	client  *http.Client
}

var instance = &Provider{baseURL: "https://api.stripe.com", client: &http.Client{Timeout: 20 * time.Second}}

func init() {
	module.RegisterGoModule(stripeModule{})
	payment.Register(Name, instance)
}

// Use gives the provider its settings store; called once at boot (internal/app).
func Use(store Store) *Provider {
	instance.store = store
	return instance
}

type stripeModule struct{}

func (stripeModule) Name() string    { return Name }
func (stripeModule) Register() error { return nil } // no table: settings live in app_settings

func (p *Provider) load(ctx context.Context, tenant uuid.UUID) (Settings, error) {
	var s Settings
	if p.store == nil {
		return s, nil
	}
	raw, ok, err := p.store.Get(ctx, tenant, uuid.Nil, SettingsKey)
	if err != nil || !ok || raw == "" {
		return s, err
	}
	return s, json.Unmarshal([]byte(raw), &s)
}

// Configured: enabled, with both keys saved.
func (p *Provider) Configured(ctx context.Context, tenant uuid.UUID) (bool, error) {
	s, err := p.load(ctx, tenant)
	return s.Enabled && s.SecretKey != "" && s.WebhookSecret != "", err
}

// CreateCheckout opens a Stripe Checkout session for one line of req.Amount.
func (p *Provider) CreateCheckout(ctx context.Context, tenant uuid.UUID, req payment.CheckoutRequest) (payment.Checkout, error) {
	s, err := p.load(ctx, tenant)
	if err != nil {
		return payment.Checkout{}, err
	}
	form := url.Values{
		"mode":                                   {"payment"},
		"client_reference_id":                    {req.Reference},
		"success_url":                            {req.SuccessURL},
		"cancel_url":                             {req.CancelURL},
		"expires_at":                             {strconv.FormatInt(req.ExpiresAt.Unix(), 10)},
		"metadata[reference]":                    {req.Reference},
		"line_items[0][quantity]":                {"1"},
		"line_items[0][price_data][currency]":    {strings.ToLower(req.Currency)},
		"line_items[0][price_data][unit_amount]": {strconv.FormatInt(req.Amount, 10)},
		"line_items[0][price_data][product_data][name]": {req.Description},
	}
	if req.CustomerEmail != "" {
		form.Set("customer_email", req.CustomerEmail)
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v1/checkout/sessions", strings.NewReader(form.Encode()))
	if err != nil {
		return payment.Checkout{}, err
	}
	r.SetBasicAuth(s.SecretKey, "")
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := p.client.Do(r)
	if err != nil {
		return payment.Checkout{}, fmt.Errorf("stripe: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		return payment.Checkout{}, fmt.Errorf("stripe: checkout %d: %s", res.StatusCode, e.Error.Message)
	}
	var out struct{ ID, URL string }
	if err := json.Unmarshal(body, &out); err != nil || out.URL == "" {
		return payment.Checkout{}, fmt.Errorf("stripe: unexpected checkout response")
	}
	return payment.Checkout{ID: out.ID, URL: out.URL}, nil
}

// ParseWebhook verifies the Stripe-Signature header (HMAC-SHA256 of
// "<t>.<body>" with the webhook secret, at most signatureTolerance old) and
// maps checkout.session.completed (paid) and checkout.session.expired.
func (p *Provider) ParseWebhook(ctx context.Context, tenant uuid.UUID, body []byte, header http.Header) (payment.WebhookEvent, error) {
	s, err := p.load(ctx, tenant)
	if err != nil {
		return payment.WebhookEvent{}, err
	}
	if s.WebhookSecret == "" || !validSignature(header.Get("Stripe-Signature"), body, s.WebhookSecret, time.Now()) {
		return payment.WebhookEvent{}, ErrSignature
	}
	var ev struct {
		Type string `json:"type"`
		Data struct {
			Object struct {
				Reference     string `json:"client_reference_id"`
				PaymentStatus string `json:"payment_status"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		return payment.WebhookEvent{}, fmt.Errorf("stripe: webhook body: %w", err)
	}
	out := payment.WebhookEvent{Reference: ev.Data.Object.Reference}
	switch ev.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		out.Paid = ev.Data.Object.PaymentStatus == "paid"
	case "checkout.session.expired", "checkout.session.async_payment_failed":
		out.Expired = true
	}
	return out, nil
}

func validSignature(header string, body []byte, secret string, now time.Time) bool {
	var ts int64
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch k {
		case "t":
			ts, _ = strconv.ParseInt(v, 10, 64)
		case "v1":
			sigs = append(sigs, v)
		}
	}
	if ts == 0 || len(sigs) == 0 {
		return false
	}
	if age := now.Sub(time.Unix(ts, 0)); age > signatureTolerance || age < -signatureTolerance {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", ts, body)
	want := hex.EncodeToString(mac.Sum(nil))
	for _, sig := range sigs {
		if hmac.Equal([]byte(sig), []byte(want)) {
			return true
		}
	}
	return false
}
