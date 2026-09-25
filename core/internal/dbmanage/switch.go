package dbmanage

import (
	"context"
	"fmt"
)

// SwitchTo is the backward-compatible, one-call blocking path: prepare name
// if it isn't already a ready standby, then Activate it. Kept for any
// script/caller that wants the old do-everything-in-one-request behavior —
// the new UI flow (Handler.Prepare, then Handler.Activate once ready) is
// what actually achieves low-downtime switching; this wrapper still pays the
// old full-provisioning cost synchronously when nothing was pre-prepared.
//
// If another caller's Prepare(name) is already in flight when this runs,
// this does NOT block waiting for it — Prepare's own preparing-guard makes
// this call a no-op, and the following Activate then simply reports
// ErrNotReady ("still preparing"), rather than silently racing a second
// provisioning attempt against the same target.
func (m *Manager) SwitchTo(ctx context.Context, name string) error {
	if err := validateName(name); err != nil {
		return err
	}

	m.mu.RLock()
	t := m.prepared[name]
	m.mu.RUnlock()

	if t == nil || !t.ready {
		if err := m.Prepare(ctx, name); err != nil {
			return fmt.Errorf("dbmanage: provision schema on %s: %w", name, err)
		}
	}

	return m.Activate(ctx, name)
}
