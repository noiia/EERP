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
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go"

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

	// `pdf-service -healthcheck` is the container healthcheck: probing
	// ourselves from the same binary means the image needs no curl.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		if err := healthcheck(addr); err != nil {
			log.Fatalf("pdf-service: healthcheck: %v", err)
		}
		return
	}

	// Default 4: enough to overlap one render's network wait with another's
	// print, few enough that a burst can't OOM a small container.
	maxConcurrent, _ := strconv.Atoi(os.Getenv("MAX_CONCURRENT_RENDERS"))
	if maxConcurrent <= 0 {
		maxConcurrent = 4
	}

	r, err := renderer.NewChromeRenderer(execPath, maxConcurrent)
	if err != nil {
		log.Fatalf("pdf-service: %v", err)
	}
	defer r.Close()

	// NATS worker mode (docs/roadmaps/pdf-reports.md Phase 5) — optional,
	// coexists with the HTTP server below. NATS_URL unset (the default)
	// means this replica only ever serves HTTP, unchanged from Phase 1.
	if natsURL := os.Getenv("NATS_URL"); natsURL != "" {
		nc, err := nats.Connect(natsURL)
		if err != nil {
			log.Fatalf("pdf-service: connect nats %s: %v", natsURL, err)
		}
		defer nc.Close()
		if _, err := runNATSWorker(nc, r); err != nil {
			log.Fatalf("pdf-service: nats subscribe: %v", err)
		}
		log.Printf("pdf-service subscribed to %q (queue %q) at %s", renderSubject, workerQueueGroup, natsURL)
	}

	log.Printf("pdf-service listening on %s (chrome: %s)", addr, execPath)
	log.Fatal(http.ListenAndServe(addr, newMux(r)))
}

func newMux(r renderer.Renderer) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("POST /render", handleRender(r))
	return mux
}

// healthcheck GETs this service's own /healthz on addr (":8090" or
// "host:port"), failing on anything but a 200.
func healthcheck(addr string) error {
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New(resp.Status)
	}
	return nil
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
