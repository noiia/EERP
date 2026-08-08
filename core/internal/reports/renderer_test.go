package reports

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/types"
)

func TestConfigured(t *testing.T) {
	cases := []struct {
		name string
		cfg  types.Config
		want bool
	}{
		{"both set (HTTP)", types.Config{PDFServiceURL: "http://pdf-service:8090", FrontendBaseURL: "http://core-front:3000"}, true},
		{"missing pdf service url", types.Config{FrontendBaseURL: "http://core-front:3000"}, false},
		{"missing frontend base url", types.Config{PDFServiceURL: "http://pdf-service:8090"}, false},
		{"neither set", types.Config{}, false},
		{"nats url alone is enough (Phase 5)", types.Config{NatsURL: "nats://nats:4222", FrontendBaseURL: "http://core-front:3000"}, true},
		{"nats url without frontend base url", types.Config{NatsURL: "nats://nats:4222"}, false},
		{"both pdf_service_url and nats_url set", types.Config{PDFServiceURL: "http://pdf-service:8090", NatsURL: "nats://nats:4222", FrontendBaseURL: "http://core-front:3000"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Configured(&tc.cfg); got != tc.want {
				t.Errorf("Configured() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestHTTPPDFRenderer_PostsTheURLAndReturnsThePDFBytes(t *testing.T) {
	var gotBody renderRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/render" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.4 fake"))
	}))
	defer srv.Close()

	r := NewHTTPPDFRenderer(srv.URL)
	pdf, err := r.Render(context.Background(), "http://core-front:3000/print/report/crm.statement/1?token=abc")
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if string(pdf) != "%PDF-1.4 fake" {
		t.Errorf("unexpected body: %s", pdf)
	}
	if gotBody.URL != "http://core-front:3000/print/report/crm.statement/1?token=abc" {
		t.Errorf("pdf-service did not receive the print URL: %+v", gotBody)
	}
	if gotBody.WaitFor != "[data-report-ready]" {
		t.Errorf("wait_for = %q, want the print route's readiness marker selector", gotBody.WaitFor)
	}
}

func TestHTTPPDFRenderer_TrimsATrailingSlashOnTheBaseURL(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	r := NewHTTPPDFRenderer(srv.URL + "/")
	if _, err := r.Render(context.Background(), "http://x"); err != nil {
		t.Fatalf("Render: %v", err)
	}
	if gotPath != "/render" {
		t.Errorf("path = %q, want /render (no double slash)", gotPath)
	}
}

func TestHTTPPDFRenderer_SurfacesANonOKStatusAsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "chrome exploded", http.StatusBadGateway)
	}))
	defer srv.Close()

	r := NewHTTPPDFRenderer(srv.URL)
	if _, err := r.Render(context.Background(), "http://x"); err == nil {
		t.Fatal("expected an error for a non-200 pdf-service response, got nil")
	}
}

func TestHTTPPDFRenderer_SurfacesAConnectionFailureAsAnError(t *testing.T) {
	// No server listening on this port — a connection failure, not a bad status.
	r := NewHTTPPDFRenderer("http://127.0.0.1:1")
	if _, err := r.Render(context.Background(), "http://x"); err == nil {
		t.Fatal("expected an error when pdf-service is unreachable, got nil")
	}
}
