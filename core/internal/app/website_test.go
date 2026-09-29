package app

import (
	"context"
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/testdb"
	"core/internal/website"

	"github.com/google/uuid"
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
