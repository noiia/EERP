package dbmanage

import (
	"context"
	"errors"
	"testing"
)

// newTestManager builds a Manager with no live DB/pool at all — enough to
// exercise the pure in-memory state machine (Prepare's guards, Activate's
// not-ready rejection, Discard, PrepareStatusFor). Anything that would
// actually dial Postgres (a successful Prepare's provisionAndKeepWarm, a
// successful Activate's SwapPool) needs a real database and is out of scope
// here — see docs/adr/ADR-021-database-management.md's manual verification
// steps for that.
func newTestManager() *Manager {
	return &Manager{prepared: map[string]*preparedTarget{}}
}

func TestPrepareStatusFor(t *testing.T) {
	tests := []struct {
		name      string
		target    *preparedTarget
		wantState PrepareStatus
		wantErr   string
	}{
		{name: "never prepared", target: nil, wantState: StatusUnprepared},
		{name: "in flight", target: &preparedTarget{preparing: true}, wantState: StatusPreparing},
		{name: "ready", target: &preparedTarget{ready: true}, wantState: StatusReady},
		{name: "failed", target: &preparedTarget{err: errors.New("boom")}, wantState: StatusFailed, wantErr: "boom"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newTestManager()
			if tt.target != nil {
				m.prepared["staging"] = tt.target
			}
			gotState, gotErr := m.PrepareStatusFor("staging")
			if gotState != tt.wantState {
				t.Fatalf("status = %q, want %q", gotState, tt.wantState)
			}
			if gotErr != tt.wantErr {
				t.Fatalf("errMsg = %q, want %q", gotErr, tt.wantErr)
			}
		})
	}
}

func TestPrepare_AlreadyInFlightOrReadyIsANoOp(t *testing.T) {
	// Both guards return before provisionAndKeepWarm ever runs (which would
	// otherwise try to dial a real Postgres connection) — proven here by the
	// fact these calls succeed at all against a Manager with no conn/
	// provisioner configured.
	tests := []struct {
		name   string
		target *preparedTarget
	}{
		{name: "already preparing", target: &preparedTarget{preparing: true}},
		{name: "already ready", target: &preparedTarget{ready: true}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newTestManager()
			m.prepared["staging"] = tt.target
			if err := m.Prepare(context.Background(), "staging"); err != nil {
				t.Fatalf("Prepare: %v", err)
			}
			// The guard must not have replaced the existing entry.
			if m.prepared["staging"] != tt.target {
				t.Fatal("Prepare overwrote an in-flight/ready entry instead of no-op'ing")
			}
		})
	}
}

func TestPrepare_RejectsInvalidName(t *testing.T) {
	m := newTestManager()
	if err := m.Prepare(context.Background(), "Not Valid!"); err == nil {
		t.Fatal("expected a validation error for a malformed name")
	}
}

func TestActivate_NotReadyIsRejectedBeforeTouchingTheLivePool(t *testing.T) {
	// m.app is nil throughout this test — if Activate's not-ready check ran
	// AFTER any live-pool access, these would panic on a nil pointer instead
	// of cleanly returning ErrNotReady.
	tests := []struct {
		name   string
		target *preparedTarget
	}{
		{name: "never prepared", target: nil},
		{name: "still preparing", target: &preparedTarget{preparing: true}},
		{name: "failed", target: &preparedTarget{err: errors.New("boom")}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := newTestManager()
			if tt.target != nil {
				m.prepared["staging"] = tt.target
			}
			err := m.Activate(context.Background(), "staging")
			if !errors.Is(err, ErrNotReady) {
				t.Fatalf("Activate error = %v, want ErrNotReady", err)
			}
		})
	}
}

func TestActivate_RejectsInvalidName(t *testing.T) {
	m := newTestManager()
	if err := m.Activate(context.Background(), "Not Valid!"); err == nil {
		t.Fatal("expected a validation error for a malformed name")
	}
}

func TestDiscard_MissingNameIsASafeNoOp(t *testing.T) {
	m := newTestManager()
	m.Discard("never-prepared") // must not panic
	if _, ok := m.prepared["never-prepared"]; ok {
		t.Fatal("Discard should never leave a map entry behind")
	}
}

func TestDiscard_RemovesTheEntry(t *testing.T) {
	m := newTestManager()
	// pool is nil here — Discard must guard against calling Close on a nil
	// pool the same way a failed-attempt preparedTarget (no pool at all,
	// just an err) would exercise in practice.
	m.prepared["staging"] = &preparedTarget{ready: true}
	m.Discard("staging")
	if _, ok := m.prepared["staging"]; ok {
		t.Fatal("Discard left the entry in place")
	}
}
