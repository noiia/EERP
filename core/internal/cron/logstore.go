package cron

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// LogPath returns where a run's log file lives under dir (Config.CronLogDir)
// — one file per (tenant, cron, history row), tenant-namespaced by directory
// so a filesystem-level listing never mixes tenants. Plain local disk, not
// object storage: see Config.CronLogDir's doc comment for why.
func LogPath(dir string, tenantID, cronID, historyID uuid.UUID) string {
	return filepath.Join(dir, tenantID.String(), fmt.Sprintf("%s_%s.log", cronID, historyID))
}

// WriteLog writes a run's captured output to path, creating its parent
// directory as needed.
func WriteLog(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("cron: create log dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("cron: write log %s: %w", path, err)
	}
	return nil
}

// RemoveLog deletes a run's log file. Missing-is-fine: a log already gone
// (manually cleaned up, or a retry of a partially-failed sweep) is not an
// error — the retention sweep's goal state either way is "the file is gone."
func RemoveLog(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cron: remove log %s: %w", path, err)
	}
	return nil
}
