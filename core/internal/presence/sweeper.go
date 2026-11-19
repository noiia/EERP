package presence

import (
	"context"
	"fmt"
	"time"
)

// SweepAbsentToOffline broadcasts the absent -> offline transition for every
// row that crossed absentAfter disconnected. Nothing else changes it —
// Effective already derives "offline" purely from Connected/LastSeen, so
// this sweep exists only to PUSH that transition to already-connected
// clients (no request happens at the exact moment the 30 minutes elapses to
// trigger it otherwise). Re-broadcasting a row still under a busy/DND
// override is harmless: Effective reports that override unchanged, so the
// frontend receives an identical, idempotent update.
//
// Call on a fixed interval (core/cmd/app/main.go, mirroring
// sale.ExpireOverdueQuotes' own ticker) — no per-row "already announced"
// state needed given the idempotent re-broadcast above.
func SweepAbsentToOffline(ctx context.Context, repo *Repository, hub *Hub) error {
	rows, err := repo.ListDisconnectedPast(ctx, time.Now().Add(-absentAfter))
	if err != nil {
		return fmt.Errorf("presence: sweep: %w", err)
	}
	for _, r := range rows {
		status := Effective(r.ManualStatus, r.Connected, r.LastSeen)
		if payload := updatePayload(r.UserID, status); payload != nil {
			hub.Broadcast(r.TenantID, payload)
		}
	}
	return nil
}
