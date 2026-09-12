// Package reports wires the PDF report pipeline (docs/adr/ADR-010,
// docs/roadmaps/pdf-reports.md) into the core API: mint a short-lived print
// URL, call the standalone pdf-service to render it, and deliver the result
// through Garage — mirroring internal/pictures' object-storage shape.
package reports

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"core/internal/types"
)

// PDFRenderer is the call-site interface the handler needs to turn a print
// URL into PDF bytes. The HTTP implementation below talks to tools/pdf-service;
// tests stub it.
type PDFRenderer interface {
	Render(ctx context.Context, printURL string) ([]byte, error)
}

// Configured reports whether the config names a way to reach a renderer —
// pdf-service directly (PDFServiceURL) or via NATS (NatsURL, Phase 5) —
// and a frontend address to build print URLs against. Absent both/either,
// report generation is simply not mounted (main.go), same "absent, not
// broken" posture as pictures.S3Configured.
func Configured(cfg *types.Config) bool {
	hasRenderer := strings.TrimSpace(cfg.PDFServiceURL) != "" || strings.TrimSpace(cfg.NatsURL) != ""
	return hasRenderer && strings.TrimSpace(cfg.FrontendBaseURL) != ""
}

type httpPDFRenderer struct {
	baseURL string
	client  *http.Client
}

// NewHTTPPDFRenderer builds a PDFRenderer that calls pdf-service's POST /render.
func NewHTTPPDFRenderer(baseURL string) PDFRenderer {
	return &httpPDFRenderer{baseURL: strings.TrimSuffix(baseURL, "/"), client: &http.Client{}}
}

type renderRequest struct {
	URL     string `json:"url"`
	WaitFor string `json:"wait_for"`
}

// Render calls pdf-service. WaitFor is fixed to the print route's own
// readiness marker (core-front/apps/shell/app/print/report/[name]/[id]/page.tsx) —
// every report waits on the same selector, so there's nothing to parameterize.
func (r *httpPDFRenderer) Render(ctx context.Context, printURL string) ([]byte, error) {
	body, err := json.Marshal(renderRequest{URL: printURL, WaitFor: "[data-report-ready]"})
	if err != nil {
		return nil, fmt.Errorf("reports: encode render request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/render", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("reports: build render request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reports: call pdf-service: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reports: read pdf-service response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("reports: pdf-service returned %d: %s", resp.StatusCode, string(respBody))
	}
	return respBody, nil
}
