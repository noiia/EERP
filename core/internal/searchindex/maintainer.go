package searchindex

import (
	"context"
	"time"

	"core/internal/common"
	"core/orm"

	"go.uber.org/zap"
)

// Run is the end of the schema workflow: a pass right after boot, then one
// every interval until ctx is done — so a table that crosses
// DefaultPolicy.MinTableRows, a newly activated module or a database
// switched to at runtime (internal/dbmanage swaps db's pool in place) gets
// its indexes without a restart. Started by App.Run.
func Run(ctx context.Context, db *orm.DB, interval time.Duration) {
	pass := func() {
		created, err := Ensure(ctx, db)
		if len(created) > 0 {
			common.Logger.Info("searchindex: built trigram indexes", zap.Strings("indexes", created))
		}
		if err != nil && ctx.Err() == nil {
			common.Logger.Warn("searchindex: pass", zap.Error(err))
		}
	}
	pass()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pass()
		}
	}
}
