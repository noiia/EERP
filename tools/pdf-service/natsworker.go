package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/nats-io/nats.go"

	"pdf-service/renderer"
)

// renderSubject/workerQueueGroup/errorHeader form the wire contract with
// core/internal/reports' natsPDFRenderer (docs/roadmaps/pdf-reports.md
// Phase 5) — two separate Go modules, so these constants are duplicated on
// both sides rather than shared; keep them in sync by hand if either changes.
const (
	renderSubject    = "reports.render"
	workerQueueGroup = "pdf-workers"
	errorHeader      = "X-Render-Error"
)

type natsRenderRequest struct {
	URL        string `json:"url"`
	WaitFor    string `json:"wait_for"`
	TimeoutSec int    `json:"timeout_seconds"`
}

// runNATSWorker subscribes to renderSubject as one member of
// workerQueueGroup — N replicas of this service form a competing-consumer
// group for free, NATS load-balancing jobs across whichever are alive; that
// is the entire "plug in more workers" story (docs/adr/ADR-010). Coexists
// with the HTTP server; both call the SAME renderer.Renderer, so this is
// purely an additional front door, not a second render pipeline.
func runNATSWorker(nc *nats.Conn, r renderer.Renderer) (*nats.Subscription, error) {
	return nc.QueueSubscribe(renderSubject, workerQueueGroup, func(msg *nats.Msg) {
		var body natsRenderRequest
		if err := json.Unmarshal(msg.Data, &body); err != nil {
			respondError(msg, "malformed request")
			return
		}
		if body.URL == "" {
			respondError(msg, "url is required")
			return
		}
		var timeout time.Duration
		if body.TimeoutSec > 0 {
			timeout = time.Duration(body.TimeoutSec) * time.Second
		}

		pdf, err := r.Render(context.Background(), renderer.RenderRequest{
			URL:     body.URL,
			WaitFor: body.WaitFor,
			Timeout: timeout,
		})
		if err != nil {
			log.Printf("nats render failed for %s: %v", body.URL, err)
			respondError(msg, "render failed")
			return
		}
		if err := msg.Respond(pdf); err != nil {
			log.Printf("nats respond failed: %v", err)
		}
	})
}

// respondError replies with a header instead of a JSON body — the success
// reply IS the raw PDF, so the caller distinguishes failure by header
// presence rather than sniffing whether the body looks like a PDF.
func respondError(msg *nats.Msg, message string) {
	reply := nats.NewMsg(msg.Reply)
	reply.Header.Set(errorHeader, message)
	if err := msg.RespondMsg(reply); err != nil {
		log.Printf("nats respond error failed: %v", err)
	}
}
