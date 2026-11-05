package notify_test

import (
	"context"
	"testing"
	"time"

	"core/internal/notify"
	"core/internal/testdb"

	"github.com/google/uuid"
)

// A database that can't be reached is an error from every repository call —
// never an empty feed or a silently skipped write.
func TestRepository_DatabaseDown(t *testing.T) {
	repo := notify.NewRepository(testdb.Closed(t).DB)
	ctx := context.Background()
	tenant, user := uuid.New(), uuid.New()
	done := "done"
	calls := map[string]func() error{
		"SyncCatalog": func() error { return repo.SyncCatalog(ctx) },
		"Create":      func() error { _, err := repo.Create(ctx, notify.Notification{Kind: "message", Title: "x"}); return err },
		"UpdateActivity": func() error {
			_, err := repo.UpdateActivity(ctx, uuid.New(), notify.ActivityUpdate{Status: &done})
			return err
		},
		"CallerCategories": func() error { _, err := repo.CallerCategories(ctx, tenant, user); return err },
		"Audience":         func() error { _, err := repo.Audience(ctx, tenant, "cron"); return err },
		"Feed":             func() error { _, _, err := repo.Feed(ctx, tenant, user); return err },
		"MarkRead":         func() error { _, err := repo.MarkRead(ctx, tenant, user, []uuid.UUID{uuid.New()}, false); return err },
		"MarkAllRead":      func() error { _, err := repo.MarkRead(ctx, tenant, user, nil, true); return err },
		"Sweep":            func() error { _, err := repo.Sweep(ctx, time.Now()); return err },
		"FailInterrupted":  func() error { _, err := repo.FailInterrupted(ctx, time.Now()); return err },
		"RunningActivity":  func() error { _, err := repo.RunningActivity(ctx, tenant, "dev_seed"); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Fatal("want an error on a closed database")
			}
		})
	}
}
