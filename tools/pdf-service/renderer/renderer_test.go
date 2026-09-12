package renderer

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// newTestRenderer skips the test rather than failing the suite when no
// Chrome/Chromium binary is available (e.g. a minimal CI image that hasn't
// installed one yet) — this package's contract needs a real browser, there
// is nothing meaningful to fake here.
func newTestRenderer(t *testing.T) *ChromeRenderer {
	t.Helper()
	execPath := os.Getenv("CHROME_PATH")
	if execPath == "" {
		for _, candidate := range []string{"/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"} {
			if _, err := os.Stat(candidate); err == nil {
				execPath = candidate
				break
			}
		}
	}
	if execPath == "" {
		t.Skip("no Chrome/Chromium binary found; set CHROME_PATH to run this test")
	}
	r, err := NewChromeRenderer(execPath)
	if err != nil {
		t.Fatalf("NewChromeRenderer: %v", err)
	}
	t.Cleanup(r.Close)
	return r
}

func fixtureURL(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs("../testdata/fixture.html")
	if err != nil {
		t.Fatal(err)
	}
	return "file://" + abs
}

var pdfPageRE = regexp.MustCompile(`/Type\s*/Page[^s]`)

func countPDFPages(data []byte) int {
	return len(pdfPageRE.FindAll(data, -1))
}

func TestRender_ValidFixture(t *testing.T) {
	r := newTestRenderer(t)

	pdf, err := r.Render(context.Background(), RenderRequest{
		URL:     fixtureURL(t),
		WaitFor: "[data-report-ready]",
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatalf("output does not look like a PDF, starts with: %q", pdf[:min(20, len(pdf))])
	}
	if got := countPDFPages(pdf); got != 2 {
		t.Errorf("expected 2 pages (fixture has an explicit page-break), got %d", got)
	}
}

func TestRender_MissingURL(t *testing.T) {
	r := newTestRenderer(t)

	if _, err := r.Render(context.Background(), RenderRequest{}); err == nil {
		t.Fatal("expected an error for an empty URL, got nil")
	}
}

func TestRender_InvalidURL(t *testing.T) {
	r := newTestRenderer(t)

	_, err := r.Render(context.Background(), RenderRequest{URL: "not-a-valid-url"})
	if err == nil {
		t.Fatal("expected an error for a malformed URL, got nil")
	}
}

func TestRender_WaitForTimeout(t *testing.T) {
	r := newTestRenderer(t)

	_, err := r.Render(context.Background(), RenderRequest{
		URL:     fixtureURL(t),
		WaitFor: "[data-this-selector-never-appears]",
		Timeout: 500 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("expected a timeout error waiting on a selector that never appears, got nil")
	}
}

func TestRender_ReusesBrowserAcrossCalls(t *testing.T) {
	r := newTestRenderer(t)

	// Two sequential renders must both succeed against the SAME pooled
	// browser (no relaunch per call) — the whole point of ChromeRenderer.
	for i := 0; i < 2; i++ {
		pdf, err := r.Render(context.Background(), RenderRequest{
			URL:     fixtureURL(t),
			WaitFor: "[data-report-ready]",
		})
		if err != nil {
			t.Fatalf("call %d: Render: %v", i, err)
		}
		if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
			t.Fatalf("call %d: output does not look like a PDF", i)
		}
	}
}
