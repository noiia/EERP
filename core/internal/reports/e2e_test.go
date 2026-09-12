//go:build integration

package reports_test

// TestGeneratePDF_EndToEnd drives the FULL pipeline over real HTTP against a
// live stack (core, tools/pdf-service, and the Next frontend, wired together
// via pdf_service_url/frontend_base_url) — the only way to prove this out,
// since no single Go test process can call all three services in-process
// (docs/roadmaps/pdf-reports.md Phase 4). Skipped unless TEST_API_BASE names
// a reachable backend — mirroring core-front's own *.integration.test.ts
// convention (TEST_API_BASE), not a new one, so both halves of this repo
// gate "needs the real stack" tests the same way.
//
// Run it with the full stack up (core on TEST_API_BASE, tools/pdf-service,
// and core-front all pointed at each other per eerp-config.json's
// pdf_service_url/frontend_base_url):
//
//	TEST_API_BASE=http://localhost:8080 go test -tags integration ./internal/reports/...

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/ledongthuc/pdf"
)

func TestGeneratePDF_EndToEnd(t *testing.T) {
	base := os.Getenv("TEST_API_BASE")
	if base == "" {
		t.Skip("TEST_API_BASE not set — start core + tools/pdf-service + core-front and set it to run this")
	}
	email := envOr("TEST_ADMIN_EMAIL", "admin@eerp.local")
	password := envOr("TEST_ADMIN_PASSWORD", "admin")

	client := &http.Client{Timeout: 30 * time.Second}

	token := login(t, client, base, email, password)

	// A unique name per run — the strongest possible signal that the
	// extracted text is THIS run's real data, not a stale/cached PDF.
	name := fmt.Sprintf("Statement Co %s", uuid.NewString()[:8])
	recordID := createCRM(t, client, base, token, name)

	downloadURL := generatePDF(t, client, base, token, "crm.statement", recordID)
	pdfBytes := download(t, client, base, token, downloadURL)

	if !bytes.HasPrefix(pdfBytes, []byte("%PDF-")) {
		t.Fatalf("response does not look like a PDF (first bytes: %q)", pdfBytes[:min(20, len(pdfBytes))])
	}

	tmpFile := t.TempDir() + "/report.pdf"
	if err := os.WriteFile(tmpFile, pdfBytes, 0o644); err != nil {
		t.Fatalf("write temp pdf: %v", err)
	}

	f, r, err := pdf.Open(tmpFile)
	if err != nil {
		t.Fatalf("open generated pdf: %v", err)
	}
	defer func() { _ = f.Close() }()

	// crm.statement's layout declares exactly one pageBreak, splitting
	// header/contact/metrics from notes — two pages, not just non-empty bytes.
	if got := r.NumPage(); got != 2 {
		t.Errorf("page count = %d, want 2 (crm.statement declares one pageBreak)", got)
	}

	var text strings.Builder
	for i := 1; i <= r.NumPage(); i++ {
		page := r.Page(i)
		if page.V.IsNull() {
			continue
		}
		content, err := page.GetPlainText(nil)
		if err != nil {
			t.Fatalf("extract text from page %d: %v", i, err)
		}
		text.WriteString(content)
	}
	got := text.String()

	for _, want := range []string{name, "customer"} {
		if !strings.Contains(got, want) {
			t.Errorf("extracted PDF text missing %q; got: %q", want, got)
		}
	}
}

func login(t *testing.T, client *http.Client, base, email, password string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	res, err := client.Post(base+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("login: status %d: %s", res.StatusCode, b)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	return payload.AccessToken
}

func createCRM(t *testing.T, client *http.Client, base, token, name string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"name": name, "email": "statement@example.test", "company": "Statement Co", "status": "customer",
	})
	req, err := http.NewRequest(http.MethodPost, base+"/api/v1/crm", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("create crm: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("create crm: status %d: %s", res.StatusCode, b)
	}
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode crm response: %v", err)
	}
	return payload.ID
}

func generatePDF(t *testing.T, client *http.Client, base, token, name, recordID string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+"/api/v1/reports/"+name+"/"+recordID+"/pdf", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("generate pdf: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("generate pdf: status %d: %s", res.StatusCode, b)
	}
	var payload struct {
		DownloadURL string `json:"download_url"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("decode report response: %v", err)
	}
	return payload.DownloadURL
}

func download(t *testing.T, client *http.Client, base, token, downloadURL string) []byte {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+downloadURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("download pdf: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("download pdf: status %d: %s", res.StatusCode, b)
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read pdf body: %v", err)
	}
	return b
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
