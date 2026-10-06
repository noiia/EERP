package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/settings"
	paymentstripe "core/modules/payment_stripe"

	"github.com/google/uuid"
)

func TestStripeSettingsAndWebhook(t *testing.T) {
	c := buildSiteApp(t)
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)
	old, _, _ := store.Get(ctx, auth.DevTenantID, uuid.Nil, paymentstripe.SettingsKey)
	t.Cleanup(func() { _ = store.Set(ctx, auth.DevTenantID, uuid.Nil, paymentstripe.SettingsKey, old) })

	if code, _ := c.do(http.MethodPut, "/api/v1/settings/integrations/stripe", map[string]any{"enabled": true, "secret_key": "pk_wrong"}); code != http.StatusBadRequest {
		t.Errorf("publishable key as secret = %d, want 400", code)
	}
	const whsec = "whsec_test"
	if code, body := c.do(http.MethodPut, "/api/v1/settings/integrations/stripe",
		map[string]any{"enabled": true, "secret_key": "sk_test_1", "webhook_secret": whsec}); code != http.StatusNoContent {
		t.Fatalf("save keys: %d %s", code, body)
	}
	code, body := c.do(http.MethodGet, "/api/v1/settings/integrations/stripe", nil)
	if code != http.StatusOK || strings.Contains(string(body), "sk_test_1") || strings.Contains(string(body), whsec) {
		t.Fatalf("settings GET leaks a key or failed: %d %s", code, body)
	}
	if got := decode(t, body); got["secret_key_set"] != true || got["webhook_secret_set"] != true || got["active"] != true {
		t.Errorf("settings = %v", got)
	}

	// A pending booking, as an online checkout leaves it.
	ev := map[string]any{"name": "pay-" + uuid.NewString()[:8], "kind": "sessions", "published": true}
	code, body = c.do(http.MethodPost, "/api/v1/event", ev)
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("event: %d %s", code, body)
	}
	eventID := decode(t, body)["id"].(string)
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event_booking WHERE event_id = $1`, eventID)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event_session WHERE event_id = $1`, eventID)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event WHERE id = $1`, eventID)
	})
	start := time.Now().Add(72 * time.Hour).UTC()
	var sessionID, bookingID uuid.UUID
	if err := c.a.db.DB.QueryRow(ctx, `INSERT INTO event_session (tenant_id, event_id, starts_at, ends_at, capacity, seats_taken)
		VALUES ($1, $2, $3, $4, 3, 1) RETURNING id`, auth.DevTenantID, eventID, start, start.Add(time.Hour)).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if err := c.a.db.DB.QueryRow(ctx, `INSERT INTO event_booking (tenant_id, event_id, session_id, seats, email, name, status, cancel_token, starts_at, hold_expires_at)
		VALUES ($1, $2, $3, 1, 'card@test.io', 'Card', 'pending_payment', $4, $5, now() + interval '30 minutes') RETURNING id`,
		auth.DevTenantID, eventID, sessionID, strings.Repeat("a", 32)+uuid.NewString()[:32], start).Scan(&bookingID); err != nil {
		t.Fatal(err)
	}

	webhook := func(payload, signature string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/public/payments/payment_stripe/webhook", bytes.NewBufferString(payload))
		req.Header.Set("Stripe-Signature", signature)
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, req)
		return rec.Code
	}
	sign := func(payload string) string {
		now := time.Now().Unix()
		mac := hmac.New(sha256.New, []byte(whsec))
		fmt.Fprintf(mac, "%d.%s", now, payload)
		return "t=" + strconv.FormatInt(now, 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
	}
	paid := `{"type":"checkout.session.completed","data":{"object":{"client_reference_id":"event_booking:` + bookingID.String() + `","payment_status":"paid"}}}`
	if code := webhook(paid, "t=1,v1=forged"); code != http.StatusBadRequest {
		t.Errorf("forged webhook = %d, want 400", code)
	}
	if code := webhook(paid, sign(paid)); code != http.StatusOK {
		t.Fatalf("signed webhook = %d", code)
	}
	var status string
	_ = c.a.db.DB.QueryRow(ctx, `SELECT status FROM event_booking WHERE id = $1`, bookingID).Scan(&status)
	if status != "confirmed" {
		t.Errorf("booking after the paid webhook = %q, want confirmed", status)
	}
	if code := webhook(paid, sign(paid)); code != http.StatusOK {
		t.Errorf("retried webhook = %d, want 200", code)
	}
}
