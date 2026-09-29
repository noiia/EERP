package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
