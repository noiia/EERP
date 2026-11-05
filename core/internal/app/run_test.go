package app

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"core/internal/testdb"
)

// App.Run is what a real server start executes: the background loops (cron,
// quote expiry, notifications, presence, search index, rates, event reminders,
// the mail sender) and the HTTP server. It must serve, then stop cleanly once
// its context is cancelled — that's how SIGINT/SIGTERM end the process.
func TestApp_RunServesThenStopsOnCancel(t *testing.T) {
	for _, smtp := range []bool{false, true} {
		t.Run("smtp="+strconv.FormatBool(smtp), func(t *testing.T) {
			cfg := testdb.Config(t)
			cfg.Environment = "development"
			cfg.CronLogDir = t.TempDir()
			cfg.PublicAddress = "127.0.0.1"
			cfg.BackendPort = freePort(t)
			if smtp {
				// A relay nobody listens on: the sender just retries in the background.
				cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPFrom, cfg.SMTPTLS = "127.0.0.1", freePort(t), "erp@example.com", "none"
			}
			a, err := Build(context.Background(), cfg, "", false)
			if err != nil {
				t.Fatalf("Build: %v", err)
			}
			t.Cleanup(a.Close)

			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- a.Run(ctx) }()

			url := "http://127.0.0.1:" + strconv.Itoa(cfg.BackendPort) + "/health"
			deadline := time.Now().Add(15 * time.Second)
			for {
				res, err := http.Get(url) //nolint:noctx // a local probe
				if err == nil {
					_ = res.Body.Close()
					if res.StatusCode == http.StatusOK {
						break
					}
				}
				if time.Now().After(deadline) {
					cancel()
					t.Fatalf("server never answered /health: %v", err)
				}
				time.Sleep(50 * time.Millisecond)
			}

			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("Run returned %v after cancel, want nil", err)
				}
			case <-time.After(15 * time.Second):
				t.Fatal("Run did not stop after its context was cancelled")
			}
		})
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}
