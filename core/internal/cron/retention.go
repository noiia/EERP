package cron

import (
	"context"
	"fmt"
	"time"

	"core/internal/common"
	"core/orm"

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
	return sweepHistory(ctx, db, logDir, time.Now())
}

// expiredHistory is the retention cutoff, evaluated by the database so the
// every-minute sweep reads only expired rows (it used to load every cron and
// every history row into memory each tick). A row expires once it is at
// least its owning cron's HistoryRetentionYears old — inclusive: a row must
// survive LESS than the window, not exactly it. An unset (<= 0) retention, or
// an owning cron since deleted, falls back to retentionDefaultYears.
const expiredHistory = `cron_history.created_at <= $1::timestamptz - make_interval(years => COALESCE(
	(SELECT c.history_retention_years FROM cron c
	 WHERE c.id = cron_history.cron_id AND c.deleted_at IS NULL AND c.history_retention_years > 0),
	` + "%d" + `))`

func sweepHistory(ctx context.Context, db *orm.DB, logDir string, now time.Time) error {
	histories := orm.MustRepo[CronHistory](db)
	expired, err := histories.FindAll(ctx, orm.Cond(fmt.Sprintf(expiredHistory, retentionDefaultYears), now))
	if err != nil {
		return fmt.Errorf("cron: sweep: list expired history: %w", err)
	}

	for _, h := range expired {
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
