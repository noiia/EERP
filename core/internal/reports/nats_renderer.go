package reports

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
)

// renderSubject/errorHeader form the wire contract with tools/pdf-service's
// NATS worker (docs/roadmaps/pdf-reports.md Phase 5) — two separate Go
// modules, so these constants are duplicated on both sides rather than
// shared; keep them in sync by hand if either changes.
const (
	renderSubject = "reports.render"
	errorHeader   = "X-Render-Error"
)

type natsPDFRenderer struct {
	nc      *nats.Conn
	timeout time.Duration
}

// NewNATSPDFRenderer builds a PDFRenderer that publishes a render job over
// NATS request-reply instead of calling pdf-service's HTTP API — the SAME
// PDFRenderer interface httpPDFRenderer satisfies, so GeneratePDF needs
// ZERO changes: only main.go's choice of which implementation to construct
// differs. N pdf-service replicas subscribed to the same queue group are
// competing consumers — horizontal scaling with no code change per replica
// (docs/adr/ADR-010).
func NewNATSPDFRenderer(nc *nats.Conn, timeout time.Duration) PDFRenderer {
	return &natsPDFRenderer{nc: nc, timeout: timeout}
}

type natsRenderRequest struct {
	URL     string `json:"url"`
	WaitFor string `json:"wait_for"`
}

func (r *natsPDFRenderer) Render(ctx context.Context, printURL string) ([]byte, error) {
	body, err := json.Marshal(natsRenderRequest{URL: printURL, WaitFor: "[data-report-ready]"})
	if err != nil {
		return nil, fmt.Errorf("reports: encode nats render request: %w", err)
	}

	reqCtx := ctx
	if r.timeout > 0 {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(ctx, r.timeout)
		defer cancel()
	}

	reply, err := r.nc.RequestWithContext(reqCtx, renderSubject, body)
	if err != nil {
		return nil, fmt.Errorf("reports: nats render request: %w", err)
	}
	if msg := reply.Header.Get(errorHeader); msg != "" {
		return nil, fmt.Errorf("reports: worker reported: %s", msg)
	}
	return reply.Data, nil
}
