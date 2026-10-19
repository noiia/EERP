package notify_test

import (
	"context"
	"testing"
	"time"

	"core/internal/notify"
	"core/internal/testdb"
	_ "core/modules/notify"
)

// RunSweeper sweeps at once, then hourly, until its context ends.
func TestRunSweeper_StopsWithItsContext(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "notify")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		notify.RunSweeper(ctx, notify.NewRepository(app.DB))
	}()
	time.Sleep(50 * time.Millisecond) // the immediate sweep
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("RunSweeper did not stop once its context was cancelled")
	}
}
