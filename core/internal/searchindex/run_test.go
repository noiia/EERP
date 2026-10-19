package searchindex_test

import (
	"context"
	"testing"
	"time"

	"core/internal/searchindex"
	"core/internal/testdb"
)

// Run makes a pass at once, then one per interval, until its context ends.
func TestRun_PassesUntilCancelled(t *testing.T) {
	app := testdb.Open(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		searchindex.Run(ctx, app.DB, 10*time.Millisecond)
	}()
	time.Sleep(60 * time.Millisecond) // the first pass plus a few ticks
	cancel()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("Run did not stop once its context was cancelled")
	}
}
