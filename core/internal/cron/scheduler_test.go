package cron

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// TestAttempt_UnknownAndUnconfigured exercises the two failure branches of
// attempt() that never need a database (unknown action_id, no run_as_user
// configured) — the rest of Scheduler needs a live Postgres (auth.UserRepository/
// PermissionRepository, orm.Repository[Cron]) and is covered by
// make run-back-tests instead, per this repo's usual split between pure-logic
// unit tests and DB-backed integration tests.
func TestAttempt_UnknownAndUnconfigured(t *testing.T) {
	clearForTest()
	defer clearForTest()

	s := &Scheduler{}

	t.Run("unknown action_id fails without touching run_as_user", func(t *testing.T) {
		var lines []string
		logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }

		failed := s.attempt(context.Background(), Cron{ActionID: "does.not.exist"}, logf)
		if !failed {
			t.Fatal("expected failed=true for an unregistered action_id")
		}
		if !containsSubstring(lines, "unknown action_id") {
			t.Fatalf("expected a log line mentioning the unknown action_id, got %v", lines)
		}
	})

	t.Run("no run_as_user configured fails", func(t *testing.T) {
		Register(Action{ID: "demo.action", Label: "Demo"})
		var lines []string
		logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }

		failed := s.attempt(context.Background(), Cron{ActionID: "demo.action", RunAsUserID: nil}, logf)
		if !failed {
			t.Fatal("expected failed=true with no run_as_user configured")
		}
		if !containsSubstring(lines, "no run_as_user configured") {
			t.Fatalf("expected a log line about the missing run_as_user, got %v", lines)
		}
	})
}

func containsSubstring(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}
