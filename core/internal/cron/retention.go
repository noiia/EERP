package cron

import (
	"context"
	"fmt"
	"time"

	"core/internal/common"
	"core/orm"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// retentionDefaultYears is the sliding window applied to a CronHistory row
// whose owning Cron has HistoryRetentionYears unset (0) or has itself since
// been deleted.
const retentionDefaultYears = 1

// SweepHistory hard-deletes cron_history rows (and their log files) older
// than their owning cron's retention window — "a default function to remove
// cron_history lines and files after a sliding year of life." A HARD delete
// on purpose, not the ORM's default soft delete: retention exists to
// reclaim space, and a row merely hidden behind deleted_at would still be
// "life" by any measure that matters here (docs/adr/ADR-016-cron-scheduler.md).
// Runs, and errors, per row — one bad row (an unreadable log path, say)
// never blocks the sweep of every other row.
func SweepHistory(ctx context.Context, db *orm.DB, logDir string) error {
	crons := orm.MustRepo[Cron](db)
	histories := orm.MustRepo[CronHistory](db)

	cronRows, err := crons.FindAll(ctx)
	if err != nil {
		return fmt.Errorf("cron: sweep: list crons: %w", err)
	}
	retentionByID := make(map[uuid.UUID]int, len(cronRows))
	for _, c := range cronRows {
		retentionByID[c.ID] = c.HistoryRetentionYears
	}

	historyRows, err := histories.FindAll(ctx)
	if err != nil {
		return fmt.Errorf("cron: sweep: list history: %w", err)
	}

	now := time.Now()
	for _, h := range historyRows {
		if !historyExpired(h, retentionByID, now) {
			continue
		}

		path := LogPath(logDir, h.TenantID, h.CronID, h.ID)
		if err := RemoveLog(path); err != nil {
			common.Logger.Warn("cron: retention: could not remove log file",
				zap.String("history_id", h.ID.String()), zap.String("path", path), zap.Error(err))
			continue
		}
		if _, err := histories.HardDelete(ctx, h.ID); err != nil {
			common.Logger.Warn("cron: retention: could not delete history row",
				zap.String("history_id", h.ID.String()), zap.Error(err))
		}
	}
	return nil
}

// historyExpired is the pure cutoff decision SweepHistory applies per row —
// pulled out so the date math is unit-testable without a database. years <=
// 0 (the owning cron unset it, or has since been deleted — retentionByID
// simply has no entry) falls back to retentionDefaultYears.
func historyExpired(h CronHistory, retentionByID map[uuid.UUID]int, now time.Time) bool {
	years := retentionByID[h.CronID]
	if years <= 0 {
		years = retentionDefaultYears
	}
	cutoff := now.AddDate(-years, 0, 0)
	return !h.CreatedAt.After(cutoff)
}
