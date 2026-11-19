package notify

import (
	"context"
	"time"

	"core/internal/common"

	"go.uber.org/zap"
)

// RunSweeper applies retention once at start, then hourly, until ctx ends.
func RunSweeper(ctx context.Context, repo *Repository) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if _, err := repo.Sweep(ctx, time.Now()); err != nil {
			common.Logger.Warn("notify: retention sweep", zap.Error(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
