package version_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v5"

	"core/internal/version"
)

func TestRegistry_Collect(t *testing.T) {
	r := version.NewRegistry()
	r.Register(version.Service{Name: "ok", Label: "OK", Probe: func(context.Context) (string, error) { return "0.101.0", nil }})
	r.Register(version.Service{Name: "down", Label: "Down", Probe: func(context.Context) (string, error) { return "", errors.New("unreachable") }})
	r.Register(version.Service{Name: "slow", Label: "Slow", Probe: func(ctx context.Context) (string, error) {
		<-ctx.Done() // never answers: the probe timeout must cut it off
		return "", ctx.Err()
	}})

	start := time.Now()
	entries := r.Collect(context.Background())
	if time.Since(start) > 5*time.Second {
		t.Fatalf("Collect waited %s for a silent service", time.Since(start))
	}

	tests := []struct {
		name string
		want *string
	}{
		{"core", &version.Version},
		{"ok", new("0.101.0")},
		{"down", nil},
		{"slow", nil},
	}
	if len(entries) != len(tests) {
		t.Fatalf("entries = %+v", entries)
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := entries[i]
			if got.Name != tc.name {
				t.Fatalf("entry %d = %q, want %q (registration order)", i, got.Name, tc.name)
			}
			switch {
			case tc.want == nil && got.Version != nil:
				t.Errorf("version = %q, want unavailable", *got.Version)
			case tc.want != nil && (got.Version == nil || *got.Version != *tc.want):
				t.Errorf("version = %v, want %q", got.Version, *tc.want)
			}
		})
	}
}

func TestHTTPProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"version":"0.102.0"}`))
	}))
	defer srv.Close()

	got, err := version.HTTPProbe(srv.Client(), srv.URL+"/")(context.Background())
	if err != nil || got != "0.102.0" {
		t.Fatalf("HTTPProbe = %q, %v", got, err)
	}

	if _, err := version.HTTPProbe(srv.Client(), srv.URL+"/nope")(context.Background()); err == nil {
		t.Error("a non-200 answer must be an error")
	}
}

func TestNATSProbe_NoConnection(t *testing.T) {
	if _, err := version.NATSProbe(nil, "pdf-service")(context.Background()); err == nil {
		t.Error("a probe without a NATS connection must fail, not panic")
	}
}

func TestHandler(t *testing.T) {
	e := echo.New()
	rec := httptest.NewRecorder()
	c := e.NewContext(httptest.NewRequest(http.MethodGet, "/api/v1/versions", nil), rec)
	if err := version.NewRegistry().Handler(c); err != nil {
		t.Fatal(err)
	}
	var body version.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Services) != 1 || body.Services[0].Name != "core" || body.Services[0].Version == nil {
		t.Errorf("body = %s", rec.Body.String())
	}
}
