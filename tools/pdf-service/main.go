// Command pdf-service is a standalone renderer: it holds no business logic,
// no auth, no data access — it navigates a pooled headless Chromium to a
// URL core hands it and prints the result. See docs/adr/ADR-010 and
// docs/roadmaps/pdf-reports.md for why it's a separate service and not
// embedded in core.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"time"

	"pdf-service/renderer"
)

func main() {
	execPath := os.Getenv("CHROME_PATH")
	if execPath == "" {
		execPath = "/usr/bin/chromium"
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8090"
	}

	r, err := renderer.NewChromeRenderer(execPath)
	if err != nil {
		log.Fatalf("pdf-service: %v", err)
	}
	defer r.Close()

	log.Printf("pdf-service listening on %s (chrome: %s)", addr, execPath)
	log.Fatal(http.ListenAndServe(addr, newMux(r)))
}

func newMux(r renderer.Renderer) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("POST /render", handleRender(r))
	return mux
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

type renderRequestBody struct {
	URL        string `json:"url"`
	WaitFor    string `json:"wait_for"`
	TimeoutSec int    `json:"timeout_seconds"`
}

func handleRender(r renderer.Renderer) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var body renderRequestBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"malformed request body"}`, http.StatusBadRequest)
			return
		}
		if body.URL == "" {
			http.Error(w, `{"error":"url is required"}`, http.StatusBadRequest)
			return
		}

		var timeout time.Duration
		if body.TimeoutSec > 0 {
			timeout = time.Duration(body.TimeoutSec) * time.Second
		}

		pdf, err := r.Render(req.Context(), renderer.RenderRequest{
			URL:     body.URL,
			WaitFor: body.WaitFor,
			Timeout: timeout,
		})
		if err != nil {
			log.Printf("render failed for %s: %v", body.URL, err)
			status := http.StatusBadGateway
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
			}
			http.Error(w, `{"error":"render failed"}`, status)
			return
		}

		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write(pdf)
	}
}
