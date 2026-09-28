package cron

import (
	"context"
	"os"
	"testing"
	"time"

	"core/internal/testdb"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func TestSweepHistory(t *testing.T) {
	app := testdb.Open(t)
	if err := orm.Register[Cron](); err != nil {
		t.Fatalf("register cron: %v", err)
	}
	if err := orm.Register[CronHistory](); err != nil {
		t.Fatalf("register cron_history: %v", err)
	}
	testdb.Migrate(t, app, "cron", "cron_history")

	ctx := context.Background()
	crons := orm.MustRepo[Cron](app.DB)
	histories := orm.MustRepo[CronHistory](app.DB)
	tenant := uuid.New()
	logDir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	t.Cleanup(func() {
		app.DB.Exec(ctx, `DELETE FROM cron_history WHERE tenant_id = $1`, tenant) //nolint:errcheck
		app.DB.Exec(ctx, `DELETE FROM cron WHERE tenant_id = $1`, tenant)         //nolint:errcheck
	})

	newCron := func(years int) uuid.UUID {
		c, err := crons.Create(ctx, Cron{BaseModel: model.BaseModel{TenantID: tenant}, Name: "sweep-test", HistoryRetentionYears: years})
		if err != nil {
			t.Fatalf("seed cron: %v", err)
		}
		return c.ID
	}
	defaultCron, twoYears, zeroYears, gone := newCron(0), newCron(2), newCron(0), newCron(5)
	if _, err := crons.Delete(ctx, gone); err != nil { // soft delete: its rows fall back to the default
		t.Fatalf("delete cron: %v", err)
	}

	tests := []struct {
		name      string
		cronID    uuid.UUID
		createdAt time.Time
		expired   bool
	}{
		{"within default 1-year window", defaultCron, now.AddDate(0, -6, 0), false},
		{"past default 1-year window", defaultCron, now.AddDate(-1, 0, -1), true},
		{"exactly at the cutoff instant is expired (inclusive)", defaultCron, now.AddDate(-1, 0, 0), true},
		{"custom retention overrides the default", twoYears, now.AddDate(-1, -1, 0), false},
		{"zero retention falls back to the default", zeroYears, now.AddDate(-1, 0, -1), true},
		{"deleted owning cron falls back to the default", gone, now.AddDate(-1, 0, -1), true},
	}
	ids := make([]uuid.UUID, len(tests))
	for i, tt := range tests {
		h, err := histories.Create(ctx, CronHistory{BaseModel: model.BaseModel{TenantID: tenant}, CronID: tt.cronID})
		if err != nil {
			t.Fatalf("seed history: %v", err)
		}
		if _, err := app.DB.Exec(ctx, `UPDATE cron_history SET created_at = $2 WHERE id = $1`, h.ID, tt.createdAt); err != nil {
			t.Fatalf("backdate history: %v", err)
		}
		if err := WriteLog(LogPath(logDir, tenant, tt.cronID, h.ID), "log"); err != nil {
			t.Fatalf("write log: %v", err)
		}
		ids[i] = h.ID
	}

	if err := sweepHistory(ctx, app.DB, logDir, now); err != nil {
		t.Fatalf("sweepHistory: %v", err)
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var n int
			if err := app.DB.QueryRow(ctx, `SELECT count(*) FROM cron_history WHERE id = $1`, ids[i]).Scan(&n); err != nil {
				t.Fatalf("read back: %v", err)
			}
			if gotExpired := n == 0; gotExpired != tt.expired {
				t.Errorf("row deleted = %v, want %v", gotExpired, tt.expired)
			}
			_, statErr := os.Stat(LogPath(logDir, tenant, tt.cronID, ids[i]))
			if fileGone := os.IsNotExist(statErr); fileGone != tt.expired {
				t.Errorf("log file removed = %v, want %v", fileGone, tt.expired)
			}
		})
	}
}
