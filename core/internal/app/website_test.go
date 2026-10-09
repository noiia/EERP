package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/common"
	"core/internal/settings"
	"core/internal/testdb"
	"core/internal/website"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

// buildSiteApp is buildApp with the dev tenant pinned as the website tenant
// (the live dev DB holds several test tenants, so auto-detection would refuse).
func buildSiteApp(t *testing.T) *client {
	t.Helper()
	cfg := testdb.Config(t)
	cfg.Environment = "development"
	cfg.CronLogDir = t.TempDir()
	cfg.WebsiteTenantID = auth.DevTenantID.String()
	a, err := Build(context.Background(), cfg, "", false)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	t.Cleanup(a.Close)
	c := &client{t: t, h: a.Handler(), a: a}
	code, body := c.do(http.MethodPost, "/api/v1/auth/login",
		map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword})
	if code != http.StatusOK {
		t.Fatalf("login: %d %s", code, body)
	}
	c.token, _ = decode(t, body)["access_token"].(string)
	return c
}

func TestPublicRoutes(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)

	// Seed one product and publish {name} only.
	name := "pub-" + uuid.NewString()
	code, body := c.do(http.MethodPost, "/api/v1/product", map[string]any{"name": name, "description": "d", "reference": "r", "unit": "pcs", "tax_rate": 0.2, "unit_price": 12.5})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create product: %d %s", code, body)
	}
	id, _ := decode(t, body)["id"].(string)
	t.Cleanup(func() { _, _ = c.a.db.DB.Exec(ctx, `DELETE FROM product WHERE id = $1`, id) })

	oldSel, _, _ := store.Get(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("product"))
	if code, body := c.do(http.MethodPut, "/api/v1/settings/website/public/product",
		map[string]any{"fields": []string{"name"}}); code != http.StatusNoContent {
		t.Fatalf("publish: %d %s", code, body)
	}
	t.Cleanup(func() { _ = store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("product"), oldSel) })
	// product_variant must read as unpublished here, whatever the dev DB holds.
	oldVariant, _, _ := store.Get(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("product_variant"))
	if err := store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("product_variant"), `{"fields":[]}`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("product_variant"), oldVariant)
	})

	tests := []struct {
		name string
		path string
		want int
	}{
		{"published list", "/api/v1/public/product?search[name]=" + name, http.StatusOK},
		{"published record", "/api/v1/public/product/" + id, http.StatusOK},
		{"unpublished table is 404", "/api/v1/public/product_variant", http.StatusNotFound},
		{"undeclared table is 404", "/api/v1/public/crm", http.StatusNotFound},
		{"non-public filter column is 400", "/api/v1/public/product?filter[unit_price]=12.5", http.StatusBadRequest},
		{"non-public distinct is 400", "/api/v1/public/product?distinct=unit_price", http.StatusBadRequest},
		{"aggregate is 400", "/api/v1/public/product?aggregate=count", http.StatusBadRequest},
		{"publish needs a session", "/api/v1/settings/website/public", http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code, body := anon.do(http.MethodGet, tt.path, nil); code != tt.want {
				t.Errorf("status = %d, want %d: %s", code, tt.want, body)
			}
		})
	}

	t.Run("response carries only published keys", func(t *testing.T) {
		_, body := anon.do(http.MethodGet, "/api/v1/public/product/"+id, nil)
		got := decode(t, body)
		if _, leaked := got["unit_price"]; leaked || got["name"] != name {
			t.Errorf("body = %v, want id+name only", got)
		}
	})

	t.Run("forced filter hides rows", func(t *testing.T) {
		if code, _ := c.do(http.MethodPut, "/api/v1/settings/website/public/product",
			map[string]any{"fields": []string{"name"}, "filter": map[string]string{"unit_price": "999"}}); code != http.StatusNoContent {
			t.Fatal("republish failed")
		}
		if code, _ := anon.do(http.MethodGet, "/api/v1/public/product/"+id, nil); code != http.StatusNotFound {
			t.Errorf("status = %d, want 404 — row outside the forced filter", code)
		}
	})
}

func TestWebsiteAccounts(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	email := "Visitor-" + uuid.NewString() + "@Test.io"
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))`, email)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM users WHERE lower(email) = lower($1)`, email)
	})

	code, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup",
		map[string]string{"email": email, "password": "correct horse", "name": "Vi"})
	if code != http.StatusOK {
		t.Fatalf("signup: %d %s", code, body)
	}
	site := &client{t: t, h: c.h, token: decode(t, body)["access_token"].(string)}

	tests := []struct {
		name   string
		c      *client
		method string
		path   string
		body   any
		want   int
	}{
		// Review Focus #1: same address, different case.
		{"duplicate email (case-insensitive) is 409", anon, http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": strings.ToUpper(email), "password": "correct horse", "name": "X"}, http.StatusConflict},
		{"short password is 400", anon, http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": "a" + email, "password": "short", "name": "X"}, http.StatusBadRequest},
		{"bad email is 400", anon, http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": "nope", "password": "correct horse", "name": "X"}, http.StatusBadRequest},
		{"website login works", anon, http.MethodPost, "/api/v1/website/auth/login",
			map[string]string{"email": email, "password": "correct horse"}, http.StatusOK},
		{"erp login refuses a website user", anon, http.MethodPost, "/api/v1/auth/login",
			map[string]string{"email": email, "password": "correct horse"}, http.StatusUnauthorized},
		{"website login refuses the erp admin", anon, http.MethodPost, "/api/v1/website/auth/login",
			map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword}, http.StatusUnauthorized},
		// Review Focus #4: every ERP group refuses the website token.
		{"website token on generic CRUD", site, http.MethodGet, "/api/v1/crm", nil, http.StatusForbidden},
		{"website token on /me/preferences", site, http.MethodGet, "/api/v1/me/preferences", nil, http.StatusForbidden},
		{"website token on settings", site, http.MethodGet, "/api/v1/settings/tax", nil, http.StatusForbidden},
		{"website token on presence", site, http.MethodGet, "/api/v1/presence", nil, http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code, body := tt.c.do(tt.method, tt.path, tt.body); code != tt.want {
				t.Errorf("status = %d, want %d: %s", code, tt.want, body)
			}
		})
	}

	t.Run("admin create/update refuse a case-insensitive email collision", func(t *testing.T) {
		other := "Other-" + uuid.NewString() + "@Test.io"
		t.Cleanup(func() { _, _ = c.a.db.DB.Exec(ctx, `DELETE FROM users WHERE lower(email) = lower($1)`, other) })
		if code, body := c.do(http.MethodPost, "/api/v1/users", map[string]string{"email": strings.ToUpper(email)}); code != http.StatusConflict {
			t.Fatalf("create dup: %d %s", code, body)
		}
		code, body := c.do(http.MethodPost, "/api/v1/users", map[string]string{"email": other})
		if code != http.StatusCreated {
			t.Fatalf("create: %d %s", code, body)
		}
		id, _ := decode(t, body)["id"].(string)
		if code, body := c.do(http.MethodPut, "/api/v1/users/"+id, map[string]string{"email": strings.ToUpper(email)}); code != http.StatusConflict {
			t.Errorf("update dup: %d %s", code, body)
		}
	})

	t.Run("settings users list hides website users", func(t *testing.T) {
		_, body := c.do(http.MethodGet, "/api/v1/users", nil)
		if strings.Contains(strings.ToLower(string(body)), strings.ToLower(email)) {
			t.Error("website user listed in Settings → Users")
		}
	})
}

func TestWebsiteProfileAndAdmin(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	email := "visitor-" + uuid.NewString() + "@test.io"
	t.Cleanup(func() {
		// Signup also queues a verification email and creates a website contact:
		// leave no outbox row behind for a live sender to deliver.
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM mail_outbox WHERE to_address = $1`, email)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM contact WHERE email = $1`, email)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, email)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
	})
	_, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup",
		map[string]string{"email": email, "password": "correct horse", "name": "Vi"})
	site := &client{t: t, h: c.h, token: decode(t, body)["access_token"].(string)}

	if code, body := site.do(http.MethodPut, "/api/v1/website/me", map[string]string{"name": "Vivi", "phone": "0102"}); code != http.StatusNoContent {
		t.Fatalf("put me: %d %s", code, body)
	}
	_, body = site.do(http.MethodGet, "/api/v1/website/me", nil)
	if me := decode(t, body); me["name"] != "Vivi" || me["email"] != email {
		t.Fatalf("me = %v", me)
	}
	if code, _ := c.do(http.MethodGet, "/api/v1/website/me", nil); code != http.StatusForbidden {
		t.Errorf("erp token on /website/me = %d, want 403", code)
	}
	if code, _ := site.do(http.MethodPut, "/api/v1/website/me", map[string]string{"name": " "}); code != http.StatusBadRequest {
		t.Errorf("blank name = %d, want 400", code)
	}

	// ERP admin lists and disables the visitor.
	_, body = c.do(http.MethodGet, "/api/v1/website_admin/users", nil)
	var id string
	var list []map[string]any
	_ = json.Unmarshal(body, &list)
	for _, u := range list {
		if u["email"] == email {
			id, _ = u["id"].(string)
		}
	}
	if id == "" {
		t.Fatalf("visitor not in website_admin list: %s", body)
	}
	if code, body := c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"name": "Admin Set", "surname": "S"}); code != http.StatusNoContent {
		t.Fatalf("admin profile edit: %d %s", code, body)
	}
	// Partial updates leave the fields not sent untouched.
	c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"phone": "0102"})
	c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"name": "Only Name"})
	_, body = c.do(http.MethodGet, "/api/v1/website_admin/users", nil)
	list = nil
	_ = json.Unmarshal(body, &list)
	for _, u := range list {
		if u["id"] == id && (u["name"] != "Only Name" || u["surname"] != "S" || u["phone"] != "0102") {
			t.Errorf("partial update result = %v", u)
		}
	}
	if code, body := c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"disabled": true, "phone": "0999"}); code != http.StatusNoContent {
		t.Fatalf("disable: %d %s", code, body)
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"name": "X"}); code != http.StatusNotFound {
		t.Errorf("profile edit on disabled = %d, want 404", code)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/website/auth/login",
		map[string]string{"email": email, "password": "correct horse"}); code != http.StatusUnauthorized {
		t.Errorf("disabled visitor login = %d, want 401", code)
	}
	if code, _ := site.do(http.MethodGet, "/api/v1/website_admin/users", nil); code != http.StatusForbidden {
		t.Errorf("website token on website_admin = %d, want 403", code)
	}

	// Re-registering the freed address, then re-enabling the old account: 409.
	if code, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup",
		map[string]string{"email": email, "password": "correct horse", "name": "New"}); code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("re-signup: %d %s", code, body)
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"disabled": false}); code != http.StatusConflict {
		t.Errorf("re-enable with email taken = %d, want 409", code)
	}
}

// A website-role seeding failure must not block boot: only signup (which
// assigns website_user) is left unmounted.
func TestMountWebsiteAuth(t *testing.T) {
	if common.Logger == nil {
		common.Logger = zap.NewNop()
	}
	ok := func(c *echo.Context) error { return c.NoContent(http.StatusNoContent) }
	tests := []struct {
		name       string
		seedErr    error
		wantSignup int
	}{
		{"seeded", nil, http.StatusNoContent},
		{"seed failed", errors.New("idx_roles_tenant_technical_name"), http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := echo.New()
			mountWebsiteAuth(e.Group("/a"), ok, ok, ok, ok, tt.seedErr)
			for path, want := range map[string]int{"/a/signup": tt.wantSignup, "/a/login": http.StatusNoContent, "/a/refresh": http.StatusNoContent, "/a/logout": http.StatusNoContent} {
				rec := httptest.NewRecorder()
				e.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
				if rec.Code != want {
					t.Errorf("%s = %d, want %d", path, rec.Code, want)
				}
			}
		})
	}
}

func TestWebsitePages(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	slug := "t-" + uuid.NewString()[:8]
	t.Cleanup(func() { _, _ = c.a.db.DB.Exec(ctx, `DELETE FROM website_page WHERE slug = $1`, slug) })

	layout := []map[string]any{{"id": "b1", "type": "text", "x": 0, "y": 0, "w": 12, "h": 2, "config": map[string]any{"body": "Hi"}}}
	code, body := c.do(http.MethodPost, "/api/v1/website_page",
		map[string]any{"slug": slug, "title": "T", "published": false, "layout": layout})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create: %d %s", code, body)
	}
	id, _ := decode(t, body)["id"].(string)

	if code, _ := c.do(http.MethodPost, "/api/v1/website_page", map[string]any{"slug": slug, "title": "dup"}); code != http.StatusConflict {
		t.Errorf("duplicate slug = %d, want 409", code)
	}
	if code, _ := c.do(http.MethodPost, "/api/v1/website_page", map[string]any{"slug": "api", "title": "x"}); code != http.StatusBadRequest {
		t.Errorf("reserved slug = %d, want 400", code)
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/website_page/"+id, map[string]any{"layout": []map[string]any{{"id": "x", "type": "iframe", "x": 0, "y": 0, "w": 1, "h": 1}}}); code != http.StatusBadRequest {
		t.Errorf("bad block type on update = %d, want 400", code)
	}

	// Unpublished page is invisible publicly; published one is visible.
	if code, _ := anon.do(http.MethodGet, "/api/v1/public/website_page?filter[slug]="+slug, nil); code != http.StatusOK {
		t.Fatalf("public list = %d", code)
	}
	_, body = anon.do(http.MethodGet, "/api/v1/public/website_page?filter[slug]="+slug, nil)
	if decode(t, body)["total"].(float64) != 0 {
		t.Error("unpublished page visible publicly")
	}
	c.do(http.MethodPut, "/api/v1/website_page/"+id, map[string]any{"published": true})
	_, body = anon.do(http.MethodGet, "/api/v1/public/website_page?filter[slug]="+slug, nil)
	if decode(t, body)["total"].(float64) != 1 {
		t.Errorf("published page not visible: %s", body)
	}
}

func TestWebsiteRouting(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)
	old, _, _ := store.Get(ctx, auth.DevTenantID, uuid.Nil, website.RoutingKey)
	t.Cleanup(func() { _ = store.Set(ctx, auth.DevTenantID, uuid.Nil, website.RoutingKey, old) })
	_ = store.Set(ctx, auth.DevTenantID, uuid.Nil, website.RoutingKey, "")

	mode := func() string {
		code, body := anon.do(http.MethodGet, "/api/v1/public/site", nil)
		if code != http.StatusOK {
			t.Fatalf("public/site: %d %s", code, body)
		}
		return decode(t, body)["routing"].(map[string]any)["mode"].(string)
	}
	put := func(host string) int {
		b, _ := json.Marshal(website.Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"})
		req := httptest.NewRequest(http.MethodPut, "/api/v1/settings/website/routing", strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("X-EERP-Request-Host", host)
		rec := httptest.NewRecorder()
		c.h.ServeHTTP(rec, req)
		return rec.Code
	}

	if got := mode(); got != "path" {
		t.Errorf("default mode = %q, want path", got)
	}
	if code := put("localhost"); code != http.StatusBadRequest {
		t.Errorf("host mode from another host = %d, want 400", code)
	}
	if code := put("erp.acme.fr"); code != http.StatusNoContent {
		t.Fatalf("host mode from erp_host = %d, want 204", code)
	}
	if got := mode(); got != "host" {
		t.Errorf("mode after save = %q, want host", got)
	}
}

// The admin's legal notice and security.txt reach the anonymous public routes;
// robots.txt always answers.
func TestWebsiteSiteFiles(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)
	for _, key := range []string{website.LegalKey, website.SecurityKey, website.RobotsKey} {
		old, _, _ := store.Get(ctx, auth.DevTenantID, uuid.Nil, key)
		t.Cleanup(func() { _ = store.Set(ctx, auth.DevTenantID, uuid.Nil, key, old) })
	}

	if code, body := c.do(http.MethodPut, "/api/v1/settings/website/legal", map[string]any{"contact_email": "nope"}); code != http.StatusBadRequest {
		t.Errorf("bad legal = %d %s", code, body)
	}
	if code, body := c.do(http.MethodPut, "/api/v1/settings/website/legal", map[string]any{"company_name": "Acme SAS"}); code != http.StatusNoContent {
		t.Fatalf("put legal = %d %s", code, body)
	}
	if code, body := anon.do(http.MethodGet, "/api/v1/public/legal", nil); code != http.StatusOK || decode(t, body)["company_name"] != "Acme SAS" {
		t.Errorf("public legal = %d %s", code, body)
	}

	expires := time.Now().AddDate(0, 6, 0).UTC().Format(time.RFC3339)
	if code, body := c.do(http.MethodPut, "/api/v1/settings/website/security", map[string]any{"contacts": []string{"mailto:sec@acme.fr"}, "expires": expires}); code != http.StatusNoContent {
		t.Fatalf("put security = %d %s", code, body)
	}
	if code, body := anon.do(http.MethodGet, "/api/v1/public/security.txt", nil); code != http.StatusOK || !strings.Contains(string(body), "Contact: mailto:sec@acme.fr") {
		t.Errorf("public security.txt = %d %s", code, body)
	}

	if code, body := c.do(http.MethodPut, "/api/v1/settings/website/robots", map[string]any{"extra": "Disallow: /private"}); code != http.StatusNoContent {
		t.Fatalf("put robots = %d %s", code, body)
	}
	if code, body := anon.do(http.MethodGet, "/api/v1/public/robots.txt?host=localhost", nil); code != http.StatusOK || !strings.Contains(string(body), "Disallow: /private") {
		t.Errorf("public robots.txt = %d %s", code, body)
	}
}

func TestPublicEventSessions(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()

	code, body := c.do(http.MethodPost, "/api/v1/event", map[string]any{"name": "ev-" + uuid.NewString()})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create event: %d %s", code, body)
	}
	ev := decode(t, body)
	id, _ := ev["id"].(string)
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event_session WHERE event_id = $1`, id)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event WHERE id = $1`, id)
	})
	if ev["kind"] != "sessions" || ev["timezone"] != "Europe/Paris" {
		t.Fatalf("defaults not applied: %v", ev)
	}
	if code, _ := c.do(http.MethodPost, "/api/v1/event", map[string]any{"name": "x", "kind": "party"}); code != http.StatusBadRequest {
		t.Fatalf("bad kind = %d, want 400", code)
	}
	start := time.Now().Add(48 * time.Hour)
	if code, body := c.do(http.MethodPost, "/api/v1/event_session", map[string]any{
		"event_id": id, "starts_at": start, "ends_at": start.Add(time.Hour), "capacity": 8}); code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create session: %d %s", code, body)
	}

	sessions := func() []any {
		code, body := anon.do(http.MethodGet, "/api/v1/public/event/"+id+"/sessions", nil)
		if code != http.StatusOK {
			t.Fatalf("sessions: %d %s", code, body)
		}
		data, _ := decode(t, body)["data"].([]any)
		return data
	}
	if got := sessions(); len(got) != 0 {
		t.Fatalf("unpublished event exposes %d sessions", len(got))
	}
	if code, body := c.do(http.MethodPut, "/api/v1/event/"+id, map[string]any{"published": true}); code != http.StatusOK {
		t.Fatalf("publish: %d %s", code, body)
	}
	got := sessions()
	if len(got) != 1 {
		t.Fatalf("published event: %d sessions, want 1", len(got))
	}
	if left, _ := got[0].(map[string]any)["seats_left"].(float64); left != 8 {
		t.Fatalf("seats_left = %v, want 8", left)
	}
}

func TestBookingFlow(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	prefix := "flow-" + uuid.NewString()[:8]
	var eventIDs []string
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM event_booking WHERE email LIKE $1`,
			`DELETE FROM mail_outbox WHERE to_address LIKE $1`,
			`DELETE FROM contact WHERE email LIKE $1`,
			`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
			`DELETE FROM users WHERE email LIKE $1`,
		} {
			_, _ = c.a.db.DB.Exec(ctx, q, prefix+"%")
		}
		for _, id := range eventIDs {
			for _, q := range []string{
				`DELETE FROM event_booking WHERE event_id = $1`,
				`DELETE FROM chatter_message WHERE record_id = $1`,
				`DELETE FROM event_session WHERE event_id = $1`,
				`DELETE FROM event_availability WHERE event_id = $1`,
				`DELETE FROM event WHERE id = $1`,
			} {
				_, _ = c.a.db.DB.Exec(ctx, q, id)
			}
		}
	})
	mustCreate := func(path string, body map[string]any) string {
		t.Helper()
		code, resp := c.do(http.MethodPost, path, body)
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("create %s: %d %s", path, code, resp)
		}
		return decode(t, resp)["id"].(string)
	}
	newEvent := func(body map[string]any) string {
		id := mustCreate("/api/v1/event", body)
		eventIDs = append(eventIDs, id)
		return id
	}
	seatsTaken := func(sessionID string) int {
		var n int
		_ = c.a.db.DB.QueryRow(ctx, `SELECT seats_taken FROM event_session WHERE id = $1`, sessionID).Scan(&n)
		return n
	}

	eventID := newEvent(map[string]any{"name": "Flow", "kind": "sessions", "published": true})
	start := time.Now().Add(72 * time.Hour).UTC()
	sessionID := mustCreate("/api/v1/event_session", map[string]any{"event_id": eventID,
		"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 1})

	email := prefix + "-a@test.io"
	book := map[string]any{"event_id": eventID, "session_id": sessionID, "seats": 1, "email": email, "name": "Flo"}
	code, body := anon.do(http.MethodPost, "/api/v1/website/bookings", book)
	if code != http.StatusCreated {
		t.Fatalf("book: %d %s", code, body)
	}
	if got := decode(t, body); got["status"] != "confirmed" || got["id"] == nil || len(got) != 2 {
		t.Errorf("book response = %v, want exactly {id, status}", got)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/website/bookings", book); code != http.StatusConflict {
		t.Errorf("second booking on a full session = %d, want 409", code)
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/event_session/"+sessionID, map[string]any{"seats_taken": 0}); code == http.StatusOK && seatsTaken(sessionID) != 1 {
		t.Errorf("seats_taken editable through the API: %d", seatsTaken(sessionID))
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/event_session/"+sessionID, map[string]any{"capacity": 0}); code != http.StatusBadRequest {
		t.Errorf("capacity 0 = %d, want 400", code)
	}
	if code, _ := c.do(http.MethodDelete, "/api/v1/event_session/"+sessionID, nil); code != http.StatusConflict {
		t.Errorf("delete session with bookings = %d, want 409", code)
	}
	var token string
	_ = c.a.db.DB.QueryRow(ctx, `SELECT cancel_token FROM event_booking WHERE email = $1`, email).Scan(&token)
	if _, body := c.do(http.MethodGet, "/api/v1/event_booking?filter[email]="+email, nil); strings.Contains(string(body), token) || !strings.Contains(string(body), email) {
		t.Errorf("ERP list leaks cancel_token or misses the booking: %s", body)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/website/bookings/cancel", map[string]string{"token": token}); code != http.StatusOK {
		t.Errorf("cancel = %d", code)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/website/bookings/cancel", map[string]string{"token": strings.Repeat("0", 64)}); code != http.StatusNotFound {
		t.Errorf("cancel unknown token = %d, want 404", code)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/website/bookings", book); code != http.StatusCreated {
		t.Errorf("rebook after cancel = %d, want 201", code)
	}

	t.Run("request validation", func(t *testing.T) {
		for name, tt := range map[string]struct {
			body map[string]any
			want int
		}{
			"bad email":          {map[string]any{"event_id": eventID, "session_id": sessionID, "seats": 1, "email": "nope", "name": "X"}, http.StatusBadRequest},
			"unknown event":      {map[string]any{"event_id": uuid.NewString(), "session_id": sessionID, "seats": 1, "email": prefix + "-x@test.io", "name": "X"}, http.StatusNotFound},
			"malformed event id": {map[string]any{"event_id": "x", "seats": 1}, http.StatusBadRequest},
		} {
			if code, body := anon.do(http.MethodPost, "/api/v1/website/bookings", tt.body); code != tt.want {
				t.Errorf("%s: %d %s, want %d", name, code, body, tt.want)
			}
		}
	})

	t.Run("appointment slots", func(t *testing.T) {
		apptID := newEvent(map[string]any{"name": "Appt", "kind": "appointment", "published": true, "slot_minutes": 60, "slot_capacity": 1, "min_notice_hours": 0, "timezone": "UTC"})
		for wd := 0; wd < 7; wd++ {
			mustCreate("/api/v1/event_availability", map[string]any{"event_id": apptID, "weekday": wd, "from_time": "09:00", "to_time": "12:00"})
		}
		from := time.Now().Add(48 * time.Hour).UTC().Truncate(24 * time.Hour)
		q := "?from=" + from.Format(time.RFC3339) + "&to=" + from.Add(24*time.Hour).Format(time.RFC3339)
		code, body := anon.do(http.MethodGet, "/api/v1/public/event/"+apptID+"/slots"+q, nil)
		if code != http.StatusOK {
			t.Fatalf("slots: %d %s", code, body)
		}
		slots, _ := decode(t, body)["data"].([]any)
		if len(slots) != 3 {
			t.Fatalf("slots = %v, want 3", slots)
		}
		first := slots[0].(map[string]any)["start"].(string)
		b := map[string]any{"event_id": apptID, "slot_start": first, "seats": 1, "email": prefix + "-s@test.io", "name": "S"}
		if code, body := anon.do(http.MethodPost, "/api/v1/website/bookings", b); code != http.StatusCreated {
			t.Fatalf("book slot: %d %s", code, body)
		}
		if _, body := anon.do(http.MethodGet, "/api/v1/public/event/"+apptID+"/slots"+q, nil); len(decode(t, body)["data"].([]any)) != 2 {
			t.Errorf("booked slot still listed: %s", body)
		}
		if code, _ := anon.do(http.MethodGet, "/api/v1/public/event/"+apptID+"/slots?from=nope", nil); code != http.StatusBadRequest {
			t.Errorf("bad from = %d, want 400", code)
		}
		if code, _ := anon.do(http.MethodGet, "/api/v1/public/event/"+eventID+"/slots", nil); code != http.StatusNotFound {
			t.Errorf("slots of a sessions event = %d, want 404", code)
		}
	})

	t.Run("website user: my bookings", func(t *testing.T) {
		code, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": prefix + "-u@test.io", "password": "correct horse", "name": "U"})
		if code != http.StatusOK {
			t.Fatalf("signup: %d %s", code, body)
		}
		site := &client{t: t, h: c.h, token: decode(t, body)["access_token"].(string)}
		s2 := mustCreate("/api/v1/event_session", map[string]any{"event_id": eventID,
			"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 5})
		code, body = site.do(http.MethodPost, "/api/v1/website/bookings",
			map[string]any{"event_id": eventID, "session_id": s2, "seats": 2, "email": prefix + "-u@test.io", "name": "U"})
		if code != http.StatusCreated {
			t.Fatalf("logged-in book: %d %s", code, body)
		}
		mine := decode(t, body)["id"].(string)
		code, body = site.do(http.MethodGet, "/api/v1/website/me/bookings", nil)
		if code != http.StatusOK {
			t.Fatalf("me/bookings: %d %s", code, body)
		}
		list, _ := decode(t, body)["data"].([]any)
		if len(list) != 1 || list[0].(map[string]any)["event_name"] != "Flow" || list[0].(map[string]any)["seats"] != 2.0 {
			t.Fatalf("me/bookings = %s", body)
		}
		if code, _ := anon.do(http.MethodGet, "/api/v1/website/me/bookings", nil); code != http.StatusUnauthorized {
			t.Errorf("anonymous me/bookings = %d, want 401", code)
		}
		if code, _ := c.do(http.MethodPost, "/api/v1/website/bookings", book); code != http.StatusForbidden {
			t.Errorf("erp token on website bookings = %d, want 403", code)
		}
		var anonID string
		_ = c.a.db.DB.QueryRow(ctx, `SELECT id FROM event_booking WHERE email = $1 AND status = 'confirmed'`, email).Scan(&anonID)
		if code, _ := site.do(http.MethodPost, "/api/v1/website/me/bookings/"+anonID+"/cancel", nil); code != http.StatusNotFound {
			t.Errorf("cancel someone else's booking = %d, want 404", code)
		}
		if code, _ := site.do(http.MethodPost, "/api/v1/website/me/bookings/"+mine+"/cancel", nil); code != http.StatusOK || seatsTaken(s2) != 0 {
			t.Errorf("cancel mine = %d, seats_taken %d", code, seatsTaken(s2))
		}
	})

	t.Run("staff overrides", func(t *testing.T) {
		draftID := newEvent(map[string]any{"name": "Draft", "kind": "sessions"})
		s3 := mustCreate("/api/v1/event_session", map[string]any{"event_id": draftID,
			"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 5})
		if code, _ := c.do(http.MethodPost, "/api/v1/event_session", map[string]any{"event_id": draftID,
			"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(-time.Hour).Format(time.RFC3339), "capacity": 5}); code != http.StatusBadRequest {
			t.Errorf("session ending before it starts = %d, want 400", code)
		}
		if code, _ := anon.do(http.MethodPost, "/api/v1/website/bookings", map[string]any{"event_id": draftID, "session_id": s3,
			"seats": 1, "email": prefix + "-x@test.io", "name": "X", "Staff": true, "staff": true}); code != http.StatusNotFound {
			t.Errorf("visitor booking an unpublished event with a staff flag = %d, want 404", code)
		}
		code, body := c.do(http.MethodPost, "/api/v1/event_booking",
			map[string]any{"event_id": draftID, "session_id": s3, "seats": 3, "email": prefix + "-staff@test.io", "name": "St"})
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("staff book unpublished: %d %s", code, body)
		}
		id := decode(t, body)["id"].(string)
		if code, _ := c.do(http.MethodPost, "/api/v1/event_booking", map[string]any{"event_id": draftID, "session_id": s3, "seats": 1, "name": "No email"}); code != http.StatusBadRequest {
			t.Errorf("staff book without email = %d, want 400", code)
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_session/"+s3, map[string]any{"capacity": 2}); code != http.StatusBadRequest {
			t.Errorf("capacity below seats_taken = %d, want 400", code)
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_session/"+s3, map[string]any{"event_id": nil}); code != http.StatusBadRequest {
			t.Errorf("event_id null = %d, want 400", code)
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_session/"+s3, map[string]any{"event_id": eventID}); code != http.StatusBadRequest {
			t.Errorf("moving a session to another event = %d, want 400", code)
		}
		if code, body := c.do(http.MethodPut, "/api/v1/event_session/"+s3, map[string]any{"event_id": draftID, "capacity": 6}); code != http.StatusOK {
			t.Errorf("PUT with the unchanged event_id = %d %s, want 200", code, body)
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_session/"+s3, map[string]any{"ends_at": start.Add(-time.Hour).Format(time.RFC3339)}); code != http.StatusBadRequest {
			t.Errorf("partial PUT inverting the session = %d, want 400", code)
		}
		for name, b := range map[string]map[string]any{
			"seats":   {"seats": 1},
			"session": {"session_id": sessionID},
			"status":  {"status": "pending"},
			"email":   {"email": "x@test.io"},
		} {
			if code, _ := c.do(http.MethodPut, "/api/v1/event_booking/"+id, b); code != http.StatusBadRequest {
				t.Errorf("PUT %s = %d, want 400", name, code)
			}
		}
		// The ERP form PUTs its whole draft: unchanged values pass.
		_, body = c.do(http.MethodGet, "/api/v1/event_booking/"+id, nil)
		draft := decode(t, body)
		draft["name"], draft["phone"] = "Renamed", "123"
		if code, body := c.do(http.MethodPut, "/api/v1/event_booking/"+id, draft); code != http.StatusOK || decode(t, body)["name"] != "Renamed" {
			t.Errorf("PUT whole draft with a new name = %d %s", code, body)
		}
		if strings.Contains(string(body), "cancel_token") {
			t.Errorf("staff booking response carries cancel_token: %s", body)
		}
		if code, _ := c.do(http.MethodDelete, "/api/v1/event_booking/"+id, nil); code != http.StatusConflict {
			t.Errorf("DELETE booking = %d, want 409", code)
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_booking/"+id, map[string]any{"status": "cancelled"}); code != http.StatusOK || seatsTaken(s3) != 0 {
			t.Errorf("staff cancel = %d, seats_taken %d", code, seatsTaken(s3))
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_booking/"+id, map[string]any{"status": "confirmed"}); code != http.StatusBadRequest || seatsTaken(s3) != 0 {
			t.Errorf("re-confirm a cancelled booking = %d, seats_taken %d; want 400, 0", code, seatsTaken(s3))
		}
		if code, _ := c.do(http.MethodDelete, "/api/v1/event_session/"+s3, nil); code != http.StatusOK && code != http.StatusNoContent {
			t.Errorf("delete session without confirmed bookings = %d", code)
		}
		if code, _ := c.do(http.MethodDelete, "/api/v1/event_session/"+s3, nil); code != http.StatusNotFound {
			t.Errorf("delete an already deleted session = %d, want 404", code)
		}
	})

	t.Run("paid event", func(t *testing.T) {
		code, body := c.do(http.MethodPost, "/api/v1/product", map[string]any{"name": prefix + "-ticket", "description": "", "reference": "T",
			"unit": "unit", "tax_rate": 0.2, "unit_price": 12.5})
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("create product: %d %s", code, body)
		}
		productID := decode(t, body)["id"].(string)
		variantID := mustCreate("/api/v1/product_variant", map[string]any{"product_id": productID, "name": "Ticket"})
		t.Cleanup(func() {
			_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM sale_line WHERE variant_id = $1`, variantID)
			_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM invoice WHERE customer_email LIKE $1`, prefix+"%")
			_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM product_variant WHERE id = $1`, variantID)
			_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM product WHERE id = $1`, productID)
		})
		paidID := newEvent(map[string]any{"name": "Paid", "kind": "sessions", "published": true, "product_variant_id": variantID})
		s6 := mustCreate("/api/v1/event_session", map[string]any{"event_id": paidID,
			"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 5})
		_, body = anon.do(http.MethodGet, "/api/v1/public/event/"+paidID+"/sessions", nil)
		sessions, _ := decode(t, body)["data"].([]any)
		if len(sessions) != 1 || sessions[0].(map[string]any)["price"] != 15.0 {
			t.Errorf("public sessions = %s, want the variant's price with tax: 15", body)
		}
		code, body = c.do(http.MethodPost, "/api/v1/event_booking", map[string]any{"event_id": paidID, "session_id": s6, "seats": 2,
			"email": prefix + "-paid@test.io", "name": "Payer"})
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("staff book: %d %s", code, body)
		}
		booking := decode(t, body)
		invoiceID, _ := booking["invoice_id"].(string)
		var total float64
		var status string
		_ = c.a.db.DB.QueryRow(ctx, `SELECT total, status FROM invoice WHERE id = $1`, invoiceID).Scan(&total, &status)
		if total != 30 || status != "sent" {
			t.Errorf("invoice %q: total %v status %q, want 30 sent", invoiceID, total, status)
		}
		// "Mark paid": the form PUTs its draft with paid_at set.
		booking["paid_at"] = time.Now().UTC().Format(time.RFC3339)
		if code, body := c.do(http.MethodPut, "/api/v1/event_booking/"+booking["id"].(string), booking); code != http.StatusOK || decode(t, body)["paid_at"] == nil {
			t.Errorf("mark paid: %d %s", code, body)
		}
		_ = c.a.db.DB.QueryRow(ctx, `SELECT status FROM invoice WHERE id = $1`, invoiceID).Scan(&status)
		if status != "paid" {
			t.Errorf("invoice after mark paid = %q", status)
		}
	})

	t.Run("waiting list", func(t *testing.T) {
		s5 := mustCreate("/api/v1/event_session", map[string]any{"event_id": eventID,
			"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 1})
		first := map[string]any{"event_id": eventID, "session_id": s5, "seats": 1, "email": prefix + "-w1@test.io", "name": "W1"}
		if code, body := anon.do(http.MethodPost, "/api/v1/website/bookings", first); code != http.StatusCreated {
			t.Fatalf("first booking: %d %s", code, body)
		}
		waiter := prefix + "-w2@test.io"
		code, body := anon.do(http.MethodPost, "/api/v1/website/bookings", map[string]any{"event_id": eventID, "session_id": s5,
			"seats": 1, "email": waiter, "name": "W2", "waitlist": true})
		if code != http.StatusCreated || decode(t, body)["status"] != "waitlisted" {
			t.Fatalf("join waiting list: %d %s", code, body)
		}
		// Staff raise the capacity: the waiting list gets the new seat as an offer.
		if code, body := c.do(http.MethodPut, "/api/v1/event_session/"+s5, map[string]any{"capacity": 2}); code != http.StatusOK {
			t.Fatalf("raise capacity: %d %s", code, body)
		}
		var token string
		_ = c.a.db.DB.QueryRow(ctx, `SELECT offer_token FROM event_booking WHERE email = $1`, waiter).Scan(&token)
		if len(token) != 64 {
			t.Fatalf("no offer after the capacity increase (token %q)", token)
		}
		if code, body := anon.do(http.MethodPost, "/api/v1/website/bookings/claim", map[string]any{"token": token}); code != http.StatusOK {
			t.Fatalf("claim: %d %s", code, body)
		}
		if seatsTaken(s5) != 2 {
			t.Errorf("seats after claim = %d, want 2", seatsTaken(s5))
		}
		if code, _ := anon.do(http.MethodPost, "/api/v1/website/bookings/claim", map[string]any{"token": token}); code != http.StatusNotFound {
			t.Errorf("second claim = %d, want 404", code)
		}
	})

	t.Run("check-in and session move", func(t *testing.T) {
		s4 := mustCreate("/api/v1/event_session", map[string]any{"event_id": eventID,
			"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 5})
		code, body := c.do(http.MethodPost, "/api/v1/event_booking",
			map[string]any{"event_id": eventID, "session_id": s4, "seats": 2, "email": prefix + "-in@test.io", "name": "In"})
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("staff book: %d %s", code, body)
		}
		id := decode(t, body)["id"].(string)
		bookingStart := func() time.Time {
			_, body := c.do(http.MethodGet, "/api/v1/event_booking/"+id, nil)
			at, _ := time.Parse(time.RFC3339, decode(t, body)["starts_at"].(string))
			return at
		}
		if !bookingStart().Equal(start.Truncate(time.Second)) {
			t.Errorf("booking starts_at = %v, want %v", bookingStart(), start)
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_booking/"+id, map[string]any{"status": "attended"}); code != http.StatusBadRequest {
			t.Errorf("check-in 3 days early = %d, want 400", code)
		}
		soon := time.Now().Add(30 * time.Minute).UTC().Truncate(time.Second)
		if code, body := c.do(http.MethodPut, "/api/v1/event_session/"+s4, map[string]any{
			"starts_at": soon.Format(time.RFC3339), "ends_at": soon.Add(time.Hour).Format(time.RFC3339)}); code != http.StatusOK {
			t.Fatalf("move session: %d %s", code, body)
		}
		if !bookingStart().Equal(soon) {
			t.Errorf("after moving the session, booking starts_at = %v, want %v", bookingStart(), soon)
		}
		if code, body := c.do(http.MethodPut, "/api/v1/event_booking/"+id, map[string]any{"status": "attended"}); code != http.StatusOK || decode(t, body)["status"] != "attended" {
			t.Errorf("check-in = %d %s", code, body)
		}
		if seatsTaken(s4) != 2 {
			t.Errorf("seats_taken after check-in = %d, want 2", seatsTaken(s4))
		}
		if code, _ := c.do(http.MethodPut, "/api/v1/event_booking/"+id, map[string]any{"status": "cancelled"}); code != http.StatusConflict {
			t.Errorf("cancel a checked-in booking = %d, want 409", code)
		}
	})
}

// Review Focus #5: earlier anonymous bookings attach to an account only once
// its email is verified, and only from that account's own session — signing
// up with someone's address and getting them to click the link claims nothing.
func TestVerifyAttachesHistoryOnlyAfterVerification(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	prefix := "verify-" + uuid.NewString()[:8]
	email := prefix + "@test.io"
	other := prefix + "-other@test.io"
	var eventID string
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM event_booking WHERE email LIKE $1`,
			`DELETE FROM mail_outbox WHERE to_address LIKE $1`,
			`DELETE FROM contact WHERE email LIKE $1`,
			`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
			`DELETE FROM users WHERE email LIKE $1`,
		} {
			_, _ = c.a.db.DB.Exec(ctx, q, prefix+"%")
		}
		for _, q := range []string{
			`DELETE FROM event_booking WHERE event_id = $1`,
			`DELETE FROM chatter_message WHERE record_id = $1`,
			`DELETE FROM event_session WHERE event_id = $1`,
			`DELETE FROM event WHERE id = $1`,
		} {
			_, _ = c.a.db.DB.Exec(ctx, q, eventID)
		}
	})
	code, body := c.do(http.MethodPost, "/api/v1/event", map[string]any{"name": "V", "kind": "sessions", "published": true})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create event: %d %s", code, body)
	}
	eventID = decode(t, body)["id"].(string)
	start := time.Now().Add(72 * time.Hour).UTC()
	code, body = c.do(http.MethodPost, "/api/v1/event_session", map[string]any{"event_id": eventID,
		"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 5})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create session: %d %s", code, body)
	}
	sessionID := decode(t, body)["id"].(string)
	// An anonymous booking made with this address (different case), before any account exists.
	if code, body := anon.do(http.MethodPost, "/api/v1/website/bookings", map[string]any{"event_id": eventID,
		"session_id": sessionID, "seats": 1, "email": strings.ToUpper(email[:1]) + email[1:], "name": "V"}); code != http.StatusCreated {
		t.Fatalf("book: %d %s", code, body)
	}

	signup := func(addr string) *client {
		t.Helper()
		code, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup", map[string]string{"email": addr, "password": "correct horse", "name": "V"})
		if code != http.StatusOK && code != http.StatusCreated {
			t.Fatalf("signup %s: %d %s", addr, code, body)
		}
		return &client{t: t, h: c.h, token: decode(t, body)["access_token"].(string)}
	}
	site, intruder := signup(email), signup(other)
	count := func(cl *client) int {
		_, body := cl.do(http.MethodGet, "/api/v1/website/me/bookings", nil)
		return len(decode(t, body)["data"].([]any))
	}
	if n := count(site); n != 0 {
		t.Fatalf("unverified account sees %d bookings, want 0", n)
	}
	// Only the hash is stored; the raw token lives in the latest queued email.
	latestToken := func() string {
		t.Helper()
		var text string
		_ = c.a.db.DB.QueryRow(ctx, `SELECT body_text FROM mail_outbox WHERE to_address = $1 AND subject LIKE 'Confirm%'
			ORDER BY created_at DESC LIMIT 1`, email).Scan(&text)
		i := strings.Index(text, "/account/verify?token=")
		if i < 0 {
			t.Fatalf("no verification link in %q", text)
		}
		return text[i+len("/account/verify?token="):][:64]
	}
	mails := func() int {
		var n int
		_ = c.a.db.DB.QueryRow(ctx, `SELECT count(*) FROM mail_outbox WHERE to_address = $1 AND subject LIKE 'Confirm%'`, email).Scan(&n)
		return n
	}
	verify := func(cl *client, token string) int {
		code, _ := cl.do(http.MethodPost, "/api/v1/website/me/verify", map[string]string{"token": token})
		return code
	}
	old := latestToken()
	var stored string
	_ = c.a.db.DB.QueryRow(ctx, `SELECT verify_token_hash FROM users WHERE email = $1`, email).Scan(&stored)
	if len(stored) != 64 || stored == old {
		t.Fatalf("stored hash %q (raw token must never be stored)", stored)
	}

	// Resend: the old link stops working, the new one is sent.
	if code, body := site.do(http.MethodPost, "/api/v1/website/me/verify/resend", nil); code != http.StatusNoContent {
		t.Fatalf("resend = %d %s", code, body)
	}
	raw := latestToken()
	if raw == old || mails() != 2 {
		t.Fatalf("resend did not issue a new link (mails=%d)", mails())
	}
	if code := verify(site, old); code != http.StatusBadRequest {
		t.Errorf("superseded token = %d, want 400", code)
	}

	if code := verify(anon, raw); code != http.StatusUnauthorized {
		t.Errorf("anonymous verify = %d, want 401", code)
	}
	if code := verify(intruder, raw); code != http.StatusBadRequest {
		t.Errorf("another user's session verifying = %d, want 400", code)
	}
	if n := count(intruder) + count(site); n != 0 {
		t.Fatalf("bookings attached by a foreign verify: %d", n)
	}
	wrong := "0" + raw[1:] // a different token, even when raw already starts with "0"
	if raw[0] == '0' {
		wrong = "1" + raw[1:]
	}
	if code := verify(site, wrong); code != http.StatusBadRequest {
		t.Errorf("wrong token = %d, want 400", code)
	}
	// Expired: same 400 as unknown.
	_, _ = c.a.db.DB.Exec(ctx, `UPDATE users SET verify_expires_at = now() - interval '1 minute' WHERE email = $1`, email)
	if code := verify(site, raw); code != http.StatusBadRequest {
		t.Errorf("expired token = %d, want 400", code)
	}
	if n := count(site); n != 0 {
		t.Fatalf("after expired verify, account sees %d bookings, want 0", n)
	}
	_, _ = c.a.db.DB.Exec(ctx, `UPDATE users SET verify_expires_at = now() + interval '1 hour' WHERE email = $1`, email)
	if code := verify(site, raw); code != http.StatusNoContent {
		t.Fatalf("owner verify = %d", code)
	}
	if n := count(site); n != 1 {
		t.Errorf("verified account sees %d bookings, want 1", n)
	}
	if code := verify(site, raw); code != http.StatusBadRequest {
		t.Errorf("reused token = %d, want 400", code)
	}
	// A verified account's resend sends nothing.
	if code, _ := site.do(http.MethodPost, "/api/v1/website/me/verify/resend", nil); code != http.StatusNoContent {
		t.Errorf("verified resend = %d, want 204", code)
	}
	if n := mails(); n != 2 {
		t.Errorf("verified resend queued a mail (%d total)", n)
	}
}

func TestPublicUpcomingEvents(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)
	oldSel, _, _ := store.Get(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("event"))
	t.Cleanup(func() { _ = store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("event"), oldSel) })
	if err := store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("event"),
		`{"fields":["name","kind","location","timezone","picture"]}`); err != nil {
		t.Fatal(err)
	}

	var ids []string
	t.Cleanup(func() {
		for _, id := range ids {
			_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event_session WHERE event_id = $1`, id)
			_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event WHERE id = $1`, id)
		}
	})
	newEvent := func(body map[string]any, sessionIn time.Duration) string {
		t.Helper()
		body["name"] = "up-" + uuid.NewString()[:8]
		body["description"] = "secret"
		code, resp := c.do(http.MethodPost, "/api/v1/event", body)
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("create event: %d %s", code, resp)
		}
		id := decode(t, resp)["id"].(string)
		ids = append(ids, id)
		if sessionIn != 0 {
			start := time.Now().Add(sessionIn).UTC()
			if code, resp := c.do(http.MethodPost, "/api/v1/event_session", map[string]any{"event_id": id,
				"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 8}); code != http.StatusCreated && code != http.StatusOK {
				t.Fatalf("create session: %d %s", code, resp)
			}
		}
		return id
	}
	sessions := newEvent(map[string]any{"kind": "sessions", "published": true, "location": "Hall"}, 48*time.Hour)
	appointment := newEvent(map[string]any{"kind": "appointment", "published": true}, 0)
	noFuture := newEvent(map[string]any{"kind": "sessions", "published": true}, 0)
	draft := newEvent(map[string]any{"kind": "sessions"}, 48*time.Hour)

	upcoming := func() map[string]map[string]any {
		t.Helper()
		code, body := anon.do(http.MethodGet, "/api/v1/public/events/upcoming?limit=50", nil)
		if code != http.StatusOK {
			t.Fatalf("upcoming: %d %s", code, body)
		}
		out := map[string]map[string]any{}
		data, _ := decode(t, body)["data"].([]any)
		for _, row := range data {
			r := row.(map[string]any)
			out[r["id"].(string)] = r
		}
		return out
	}
	got := upcoming()
	s, ok := got[sessions]
	if !ok || s["next_session_at"] == nil || s["seats_left"] != float64(8) || s["location"] != "Hall" || s["kind"] != "sessions" {
		t.Errorf("sessions event = %v, want next session, 8 seats left, location", s)
	}
	if _, leaked := s["description"]; leaked {
		t.Errorf("unpublished column description returned: %v", s)
	}
	if a, ok := got[appointment]; !ok || a["next_session_at"] != nil || a["kind"] != "appointment" {
		t.Errorf("appointment event = %v (listed %v), want listed without a session", a, ok)
	}
	for name, id := range map[string]string{"no future session": noFuture, "unpublished": draft} {
		if _, ok := got[id]; ok {
			t.Errorf("%s event listed", name)
		}
	}
	if code, _ := anon.do(http.MethodGet, "/api/v1/public/events/upcoming?limit=500", nil); code != http.StatusBadRequest {
		t.Errorf("limit 500 = %d, want 400", code)
	}
	if err := store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("event"), `{"fields":[]}`); err != nil {
		t.Fatal(err)
	}
	if code, _ := anon.do(http.MethodGet, "/api/v1/public/events/upcoming", nil); code != http.StatusNotFound {
		t.Errorf("event table unpublished = %d, want 404", code)
	}
}
