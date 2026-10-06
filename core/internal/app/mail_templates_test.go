package app

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/mail"
)

func TestMailTemplatesAdmin(t *testing.T) {
	c := buildSiteApp(t)
	ctx := context.Background()
	// "zz": a locale nobody uses, so the live dev tenant's own overrides are untouched.
	const key, path = "event.booking_cancelled", "/api/v1/settings/mail_templates/event.booking_cancelled/zz"
	t.Cleanup(func() { _ = mail.DeleteTemplate(ctx, c.a.db.DB, auth.DevTenantID, key, "zz") })

	code, body := c.do(http.MethodGet, "/api/v1/settings/mail_templates", nil)
	if code != http.StatusOK {
		t.Fatalf("catalog: %d %s", code, body)
	}
	var found map[string]any
	for _, row := range decode(t, body)["data"].([]any) {
		if r := row.(map[string]any); r["key"] == key {
			found = r
		}
	}
	if found == nil || len(found["vars"].([]any)) == 0 || found["defaults"].(map[string]any)["en"] == nil {
		t.Fatalf("catalog entry for %s = %v, want vars and an English default", key, found)
	}

	for name, req := range map[string]map[string]any{
		"unknown variable": {"subject": "Bye {{nope}}", "html": "<p>x</p>"},
		"empty subject":    {"subject": "", "html": "<p>x</p>"},
	} {
		if code, _ := c.do(http.MethodPut, path, req); code != http.StatusBadRequest {
			t.Errorf("PUT %s = %d, want 400", name, code)
		}
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/settings/mail_templates/no.such/zz", map[string]any{"subject": "x", "html": "<p>x</p>"}); code != http.StatusNotFound {
		t.Errorf("PUT unknown key = %d, want 404", code)
	}
	if code, body := c.do(http.MethodPut, path, map[string]any{"subject": "Annulé : {{event}}", "html": `<p>{{name}}</p><img src=x onerror=alert(1)>`}); code != http.StatusNoContent {
		t.Fatalf("PUT override: %d %s", code, body)
	}
	msg, err := mail.Render(ctx, c.a.db.DB, auth.DevTenantID, key, "zz", map[string]string{"event": "Yoga", "name": "Ann"})
	if err != nil {
		t.Fatal(err)
	}
	if msg.Subject != "Annulé : Yoga" || strings.Contains(msg.HTML, "img") || !strings.Contains(msg.HTML, "Ann") {
		t.Errorf("render after PUT = %+v, want the sanitized override", msg)
	}
	_, body = c.do(http.MethodGet, "/api/v1/settings/mail_templates", nil)
	if !strings.Contains(string(body), `"zz"`) {
		t.Errorf("catalog does not list the override: %s", body)
	}
	if code, _ := c.do(http.MethodDelete, path, nil); code != http.StatusNoContent {
		t.Fatalf("DELETE override = %d", code)
	}
	if msg, _ := mail.Render(ctx, c.a.db.DB, auth.DevTenantID, key, "zz", map[string]string{"event": "Yoga"}); strings.HasPrefix(msg.Subject, "Annulé") {
		t.Errorf("after DELETE subject %q, want the default", msg.Subject)
	}
}
