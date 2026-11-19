package devseed

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"core/internal/notify"

	"github.com/google/uuid"
)

// Notifier is what a seed job needs from internal/notify.
type Notifier interface {
	Start(ctx context.Context, tenant uuid.UUID, a notify.Activity) (*notify.Run, error)
	Personal(ctx context.Context, tenant, user uuid.UUID, m notify.Message) (notify.Notification, error)
	Repo() *notify.Repository
}

// SeedFunc runs one seed, reporting progress.
type SeedFunc func(ctx context.Context, progress Progress) ([]Result, error)

const developerPage = "/settings/developer"

// RunJob starts a dev_seed activity and runs seed in the background (or
// inline with wait, for tests), finishing the activity and notifying the
// initiator whatever happens — the deferred Finish means a panic or error
// can never leave the activity "running".
func RunJob(ctx context.Context, n Notifier, tenant, user uuid.UUID, seed SeedFunc, wait bool) (uuid.UUID, error) {
	run, err := n.Start(ctx, tenant, notify.Activity{
		Category: "dev_seed", Title: "Seeding demo data", Link: developerPage, ActorID: &user,
	})
	if err != nil {
		return uuid.Nil, err
	}
	job := func() {
		start := time.Now()
		var results []Result
		var seedErr error
		defer func() {
			if r := recover(); r != nil {
				seedErr = fmt.Errorf("seed panicked: %v", r)
			}
			finish(n, run, tenant, user, results, seedErr, time.Since(start))
		}()
		results, seedErr = seed(context.Background(), run.Progress)
	}
	if wait {
		job()
	} else {
		go job()
	}
	return run.ID(), nil
}

func finish(n Notifier, run *notify.Run, tenant, user uuid.UUID, results []Result, seedErr error, took time.Duration) {
	var data *string
	if seedErr == nil {
		if b, err := json.Marshal(results); err == nil {
			s := string(b)
			data = &s
		}
	}
	run.Finish(seedErr, "", data)
	msg := notify.Message{Category: "dev_seed", Link: developerPage, Data: data}
	if seedErr != nil {
		msg.Title, msg.Body = "Demo data seeding failed", seedErr.Error()
	} else {
		msg.Title = fmt.Sprintf("Demo data seeded in %.0f s", took.Seconds())
	}
	_, _ = n.Personal(context.Background(), tenant, user, msg)
}
