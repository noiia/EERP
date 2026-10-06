package paymentstripe

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"core/internal/payment"

	"github.com/google/uuid"
)

type memStore map[string]string

func (m memStore) Get(_ context.Context, _, _ uuid.UUID, key string) (string, bool, error) {
	v, ok := m[key]
	return v, ok, nil
}
func (m memStore) Set(_ context.Context, _, _ uuid.UUID, key, value string) error {
	m[key] = value
	return nil
}

func sign(secret string, at time.Time, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", at.Unix(), body)
	return "t=" + strconv.FormatInt(at.Unix(), 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestProvider(t *testing.T) {
	ctx, tenant := context.Background(), uuid.New()
	var form url.Values
	var auth string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form, _ = url.ParseQuery(string(body))
		auth, _, _ = r.BasicAuth()
		if r.URL.Path != "/v1/checkout/sessions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"id":"cs_test_1","url":"https://checkout.stripe.test/cs_test_1"}`))
	}))
	defer api.Close()
	store := memStore{}
	p := &Provider{store: store, baseURL: api.URL, client: api.Client()}

	if ok, _ := p.Configured(ctx, tenant); ok {
		t.Fatal("configured without keys")
	}
	store[SettingsKey] = `{"enabled":true,"secret_key":"sk_test_x","webhook_secret":"whsec_y"}`
	if ok, _ := p.Configured(ctx, tenant); !ok {
		t.Fatal("not configured with keys")
	}

	co, err := p.CreateCheckout(ctx, tenant, payment.CheckoutRequest{Reference: "booking:1", Amount: 3000, Currency: "EUR",
		Description: "Pottery × 2", CustomerEmail: "a@x.io", SuccessURL: "https://site/ok", CancelURL: "https://site/no",
		ExpiresAt: time.Unix(1_900_000_000, 0)})
	if err != nil || co.URL != "https://checkout.stripe.test/cs_test_1" {
		t.Fatalf("checkout = %+v %v", co, err)
	}
	for k, want := range map[string]string{"mode": "payment", "client_reference_id": "booking:1",
		"line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": "3000",
		"line_items[0][quantity]": "1", "customer_email": "a@x.io", "expires_at": "1900000000"} {
		if form.Get(k) != want {
			t.Errorf("form %s = %q, want %q", k, form.Get(k), want)
		}
	}
	if auth != "sk_test_x" {
		t.Errorf("basic auth user = %q, want the secret key", auth)
	}

	body := []byte(`{"type":"checkout.session.completed","data":{"object":{"client_reference_id":"booking:1","payment_status":"paid"}}}`)
	h := http.Header{"Stripe-Signature": {sign("whsec_y", time.Now(), body)}}
	if ev, err := p.ParseWebhook(ctx, tenant, body, h); err != nil || !ev.Paid || ev.Reference != "booking:1" {
		t.Errorf("paid webhook = %+v %v", ev, err)
	}
	expired := []byte(`{"type":"checkout.session.expired","data":{"object":{"client_reference_id":"booking:1"}}}`)
	if ev, err := p.ParseWebhook(ctx, tenant, expired, http.Header{"Stripe-Signature": {sign("whsec_y", time.Now(), expired)}}); err != nil || !ev.Expired {
		t.Errorf("expired webhook = %+v %v", ev, err)
	}
	for name, hdr := range map[string]string{
		"wrong secret": sign("whsec_other", time.Now(), body),
		"too old":      sign("whsec_y", time.Now().Add(-10*time.Minute), body),
		"missing":      "",
	} {
		if _, err := p.ParseWebhook(ctx, tenant, body, http.Header{"Stripe-Signature": {hdr}}); !errors.Is(err, ErrSignature) {
			t.Errorf("%s: %v, want ErrSignature", name, err)
		}
	}
}
