package website

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

var sfNow = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

func TestLegalNormalize(t *testing.T) {
	tests := []struct {
		name    string
		l       Legal
		wantErr bool
	}{
		{"empty is valid (no notice)", Legal{}, false},
		{"typical notice", Legal{CompanyName: " Acme SAS ", ContactEmail: "legal@acme.fr", HostName: "OVH"}, false},
		{"bad email", Legal{ContactEmail: "not an email"}, true},
		{"display-name email refused", Legal{ContactEmail: "Acme <legal@acme.fr>"}, true},
		{"field too long", Legal{CompanyName: strings.Repeat("a", maxField+1)}, true},
		{"free text too long", Legal{ExtraText: strings.Repeat("a", maxLongField+1)}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.l.normalize(); (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSecurityNormalize(t *testing.T) {
	in := func(d time.Duration) string { return sfNow.Add(d).Format(time.RFC3339) }
	tests := []struct {
		name    string
		s       Security
		wantErr bool
	}{
		{"no contact = disabled", Security{Contacts: []string{" "}}, false},
		{"mailto + https", Security{Contacts: []string{"mailto:sec@acme.fr", "https://acme.fr/sec"}, Expires: in(24 * time.Hour)}, false},
		{"tel", Security{Contacts: []string{"tel:+33123456789"}, Expires: in(24 * time.Hour)}, false},
		{"http contact refused", Security{Contacts: []string{"http://acme.fr"}, Expires: in(24 * time.Hour)}, true},
		{"bare email refused", Security{Contacts: []string{"sec@acme.fr"}, Expires: in(24 * time.Hour)}, true},
		{"missing expires", Security{Contacts: []string{"mailto:sec@acme.fr"}}, true},
		{"expired", Security{Contacts: []string{"mailto:sec@acme.fr"}, Expires: in(-time.Hour)}, true},
		{"more than a year", Security{Contacts: []string{"mailto:sec@acme.fr"}, Expires: in(400 * 24 * time.Hour)}, true},
		{"policy must be https", Security{Contacts: []string{"mailto:sec@acme.fr"}, Expires: in(time.Hour), Policy: "ftp://x"}, true},
		{"languages", Security{Contacts: []string{"mailto:sec@acme.fr"}, Expires: in(time.Hour), PreferredLanguages: "en, fr"}, false},
		{"bad languages", Security{Contacts: []string{"mailto:sec@acme.fr"}, Expires: in(time.Hour), PreferredLanguages: "en;fr"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.s.normalize(sfNow); (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSecurityText(t *testing.T) {
	s := Security{Contacts: []string{"mailto:sec@acme.fr"}, Expires: "2027-01-01T00:00:00Z", Policy: "https://acme.fr/p", PreferredLanguages: "fr"}
	want := "Contact: mailto:sec@acme.fr\nExpires: 2027-01-01T00:00:00Z\nPolicy: https://acme.fr/p\nPreferred-Languages: fr\n"
	if got := s.Text(sfNow); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := s.Text(time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC)); got != "" {
		t.Errorf("expired file still rendered: %q", got)
	}
	if got := (Security{}).Text(sfNow); got != "" {
		t.Errorf("empty file rendered: %q", got)
	}
}

func TestRobotsText(t *testing.T) {
	host := Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}
	tests := []struct {
		name     string
		r        Routing
		extra    Robots
		host     string
		contains []string
		excludes []string
	}{
		{"path mode", Routing{Mode: "path"}, Robots{}, "localhost", []string{"Disallow: /app/", "Disallow: /api/"}, []string{"Disallow: /\n"}},
		{"erp host closed", host, Robots{Extra: "Sitemap: x"}, "ERP.acme.fr:443", []string{"Disallow: /\n"}, []string{"Disallow: /app/", "Sitemap"}},
		{"site host gets rules + extra", host, Robots{Extra: "Sitemap: https://www.acme.fr/sitemap.xml"}, "www.acme.fr", []string{"Disallow: /print/", "Sitemap: https://www.acme.fr/sitemap.xml"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RobotsText(tt.r, tt.extra, tt.host)
			for _, s := range tt.contains {
				if !strings.Contains(got, s) {
					t.Errorf("missing %q in %q", s, got)
				}
			}
			for _, s := range tt.excludes {
				if strings.Contains(got, s) {
					t.Errorf("unexpected %q in %q", s, got)
				}
			}
		})
	}
}

func TestPublicSiteFiles(t *testing.T) {
	get := func(h echo.HandlerFunc, target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, target, nil), rec)
		if err := h(c); err != nil {
			if he, ok := err.(*echo.HTTPError); ok {
				rec.Code = he.Code
			} else {
				t.Fatal(err)
			}
		}
		return rec
	}
	store := memStore{}
	h := NewSiteFilesHandler(store, uuid.New())
	h.now = func() time.Time { return sfNow }

	t.Run("nothing set: legal and security.txt 404, robots has defaults", func(t *testing.T) {
		if rec := get(h.PublicLegal, "/"); rec.Code != http.StatusNotFound {
			t.Errorf("legal = %d", rec.Code)
		}
		if rec := get(h.PublicSecurityTxt, "/"); rec.Code != http.StatusNotFound {
			t.Errorf("security.txt = %d", rec.Code)
		}
		if rec := get(h.PublicRobotsTxt, "/?host=x"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Disallow: /app/") {
			t.Errorf("robots.txt = %d %q", rec.Code, rec.Body.String())
		}
	})
	t.Run("set: served", func(t *testing.T) {
		_ = store.Set(context.Background(), uuid.Nil, uuid.Nil, LegalKey, `{"company_name":"Acme"}`)
		_ = store.Set(context.Background(), uuid.Nil, uuid.Nil, SecurityKey, `{"contacts":["mailto:a@b.fr"],"expires":"2027-01-01T00:00:00Z"}`)
		if rec := get(h.PublicLegal, "/"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Acme") {
			t.Errorf("legal = %d %q", rec.Code, rec.Body.String())
		}
		rec := get(h.PublicSecurityTxt, "/")
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") || !strings.Contains(rec.Body.String(), "Contact: mailto:a@b.fr") {
			t.Errorf("security.txt = %d %q", rec.Code, rec.Body.String())
		}
	})
}
