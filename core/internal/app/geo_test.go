package app

import (
	"context"
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/website"

	"github.com/google/uuid"
)

// Real routes, real modules: a company zone, contacts inside/outside it, the
// inside[] list and the distance between two contacts.
func TestGeo_FirstUsers(t *testing.T) {
	c := buildApp(t)
	ctx := context.Background()
	var cleanup []string
	t.Cleanup(func() {
		for _, q := range cleanup {
			_, _ = c.a.db.DB.Exec(ctx, q)
		}
	})
	create := func(path string, body map[string]any) string {
		t.Helper()
		code, resp := c.do(http.MethodPost, path, body)
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("POST %s: %d %s", path, code, resp)
		}
		return decode(t, resp)["id"].(string)
	}
	pt := func(lon, lat float64) map[string]any {
		return map[string]any{"type": "Point", "coordinates": []float64{lon, lat}}
	}
	idf := map[string]any{"type": "Polygon", "coordinates": [][][]float64{{{1.4, 48.1}, {3.6, 48.1}, {3.6, 49.3}, {1.4, 49.3}, {1.4, 48.1}}}}

	tag := "geo-" + uuid.NewString()[:8]
	contact := func(suffix string, lon, lat float64) map[string]any {
		return map[string]any{"name": tag + "-" + suffix, "email": tag + suffix + "@x.fr", "company": "", "status": "lead", "geo_location": pt(lon, lat)}
	}
	in := create("/api/v1/contact", contact("in", 2.35, 48.85))
	out := create("/api/v1/contact", contact("out", 4.83, 45.76))
	cleanup = append(cleanup, "DELETE FROM contact WHERE id IN ('"+in+"','"+out+"')")

	code, resp := c.do(http.MethodGet, "/api/v1/company?page_size=1", nil)
	if code != http.StatusOK {
		t.Fatalf("company list: %d %s", code, resp)
	}
	company := decode(t, resp)["data"].([]any)[0].(map[string]any)
	companyID := company["id"].(string)
	// Shared dev DB: keep the company's existing zone (EWKT, which geography
	// parses back as is) and put it back afterwards.
	var oldZone *string
	if err := c.a.db.DB.QueryRow(ctx, `SELECT ST_AsEWKT(service_zone) FROM company WHERE id = $1`, companyID).Scan(&oldZone); err != nil {
		t.Fatalf("read old zone: %v", err)
	}
	company["service_zone"] = idf
	if code, resp := c.do(http.MethodPut, "/api/v1/company/"+companyID, company); code != http.StatusOK {
		t.Fatalf("company zone: %d %s", code, resp)
	}
	t.Cleanup(func() {
		if _, err := c.a.db.DB.Exec(ctx, `UPDATE company SET service_zone = $2::geography WHERE id = $1`, companyID, oldZone); err != nil {
			t.Errorf("restore old zone: %v", err)
		}
	})

	code, resp = c.do(http.MethodGet, "/api/v1/contact?search[name]="+tag+"&inside[geo_location]=company:"+companyID+":service_zone", nil)
	if code != http.StatusOK {
		t.Fatalf("inside list: %d %s", code, resp)
	}
	rows := decode(t, resp)["data"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["id"] != in {
		t.Errorf("contacts inside zone = %v, want only %s", rows, in)
	}

	code, resp = c.do(http.MethodGet, "/api/v1/geo/distance?from=contact:"+in+":geo_location&to=contact:"+out+":geo_location", nil)
	if code != http.StatusOK {
		t.Fatalf("distance: %d %s", code, resp)
	}
	if m, _ := decode(t, resp)["meters"].(float64); m < 390000 || m > 395000 {
		t.Errorf("distance = %s, want ~392 km", resp)
	}
}

// Public generic routes: near/within/covers on published columns only, and
// never a cross-table reference.
func TestPublicGeoParams(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)
	key := website.PublicKey("company")
	oldSel, existed, err := store.Get(ctx, auth.DevTenantID, uuid.Nil, key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if existed {
			_ = store.Set(ctx, auth.DevTenantID, uuid.Nil, key, oldSel)
			return
		}
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM app_settings WHERE tenant_id = $1 AND company_id = $2 AND key = $3`, auth.DevTenantID, uuid.Nil, key)
	})
	if err := store.Set(ctx, auth.DevTenantID, uuid.Nil, key, `{"fields":["name","geo_location"]}`); err != nil {
		t.Fatal(err)
	}
	code, resp := c.do(http.MethodGet, "/api/v1/company?page_size=1", nil)
	if code != http.StatusOK {
		t.Fatalf("company list: %d %s", code, resp)
	}
	id := decode(t, resp)["data"].([]any)[0].(map[string]any)["id"].(string)

	for _, tt := range []struct {
		name, query string
		want        int
	}{
		{"near on a published column", "near[geo_location]=2.35,48.85", http.StatusOK},
		{"covers on an unpublished column", "covers[service_zone]=2.35,48.85", http.StatusBadRequest},
		{"inside reference refused publicly", "inside[geo_location]=company:" + id + ":service_zone", http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if code, body := anon.do(http.MethodGet, "/api/v1/public/company?"+tt.query, nil); code != tt.want {
				t.Errorf("GET ?%s = %d %s, want %d", tt.query, code, body, tt.want)
			}
		})
	}
}
