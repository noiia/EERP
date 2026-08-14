package cron

import (
	"context"
	_ "embed"
	"errors"

	"core/internal/cron"
)

// Source embeds this very file's text, so the cron form's read-only "Code"
// notebook page shows the REAL Go source that runs — never a hand-written
// description that can drift from it. This is the concrete "Cron should be
// go code added by cron.go files" example (docs/adr/ADR-016-cron-scheduler.md):
// any module wanting a cron action does exactly this — a cron.go with a
// package-level init() calling cron.Register.
//
//go:embed cron.go
var source string

func init() {
	cron.Register(cron.Action{
		ID:    "cron.history_retention",
		Label: "Clean up old cron history",
		// No RequiredPermission: this only ever touches the cron/cron_history
		// tables the run-as user's own cron admin access already implies, and
		// the scheduler already runs the same sweep unconditionally every
		// tick (retention.go) — this action exists so an admin can ALSO
		// trigger (or schedule) it manually, not to gate something sensitive.
		Source: source,
		Run:    runHistoryRetention,
	})
}

// runHistoryRetention is the dogfooded example: it just re-runs the same
// sweep the scheduler already performs automatically every tick
// (internal/cron/retention.go) — see this action's own doc comment above
// for why it needs no extra permission.
func runHistoryRetention(ctx context.Context) error {
	db, logDir := cron.Env()
	if db == nil {
		return errors.New("cron: history_retention: no DB configured (cron.SetEnv was never called)")
	}
	return cron.SweepHistory(ctx, db, logDir)
}
