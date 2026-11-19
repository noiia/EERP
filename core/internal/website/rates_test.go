package website

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"core/internal/common"

	"go.uber.org/zap"
)

// The live feed over HTTP: a good answer fills the cache (EUR = 1 added), and
// every kind of bad answer is an error that keeps the previous rates.
func TestLiveRates_FetchOverHTTP(t *testing.T) {
	answers := map[string]struct {
		status int
		body   string
	}{
		"/ok":       {http.StatusOK, ecbSample},
		"/down":     {http.StatusServiceUnavailable, ""},
		"/garbage":  {http.StatusOK, "<not-xml"},
		"/no-days":  {http.StatusOK, `<Envelope><Cube></Cube></Envelope>`},
		"/no-rates": {http.StatusOK, `<Envelope><Cube><Cube time="2026-11-02"><Cube currency="usd" rate="x"/></Cube></Cube></Envelope>`},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := answers[r.URL.Path]
		w.WriteHeader(a.status)
		_, _ = w.Write([]byte(a.body))
	}))
	defer srv.Close()
	ctx := context.Background()

	l := NewLiveRates(srv.URL + "/ok")
	if err := l.Refresh(ctx); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	rates, date := l.Snapshot()
	if rates["EUR"] != 1 || rates["USD"] == 0 || date == "" {
		t.Fatalf("snapshot = %v %q, want EUR=1, USD and a date", rates, date)
	}

	for _, path := range []string{"/down", "/garbage", "/no-days", "/no-rates"} {
		t.Run(path, func(t *testing.T) {
			bad := NewLiveRates(srv.URL + path)
			bad.rates, bad.date = map[string]float64{"USD": 1.1}, "before"
			if err := bad.Refresh(ctx); err == nil {
				t.Fatal("want an error")
			}
			if r, d := bad.Snapshot(); r["USD"] != 1.1 || d != "before" {
				t.Fatalf("a failed refresh must keep the previous rates, got %v %q", r, d)
			}
		})
	}

	t.Run("unreachable host and a malformed URL", func(t *testing.T) {
		if err := NewLiveRates("http://127.0.0.1:1/feed").Refresh(ctx); err == nil {
			t.Fatal("want an error for an unreachable host")
		}
		if err := NewLiveRates("://bad").Refresh(ctx); err == nil {
			t.Fatal("want an error for a malformed URL")
		}
	})
}

func TestLiveRates_NilSnapshotAndRunStops(t *testing.T) {
	var none *LiveRates
	if r, d := none.Snapshot(); r != nil || d != "" {
		t.Fatalf("nil rates snapshot = %v %q", r, d)
	}

	// Run refreshes at once (here: failing, which it logs), then waits; cancelling ends it.
	if common.Logger == nil {
		common.Logger = zap.NewNop()
	}
	l := NewLiveRates("http://127.0.0.1:1/feed")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { l.Run(ctx); close(done) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after its context was cancelled")
	}
}

func TestRelativeTo_UnknownBase(t *testing.T) {
	if got := relativeTo(map[string]float64{"USD": 1.1}, "GBP"); len(got) != 0 {
		t.Fatalf("a base the feed doesn't quote gives nothing, got %v", got)
	}
}
