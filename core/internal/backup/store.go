package backup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"

	"go.uber.org/zap"
)

const (
	historyFile  = "history.jsonl"
	historyLimit = 500
	stampLayout  = "2006-01-02T150405Z"
	tmpDir       = ".tmp"
)

// DBResult is one database's bundle in a run.
type DBResult struct {
	Name      string `json:"name"`
	File      string `json:"file"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	S3Objects int    `json:"s3_objects"`
}

// Run is one backup execution: a history.jsonl line, and (minus its
// status fields) the run's published manifest.json.
type Run struct {
	ID         string     `json:"id"`      // the start stamp, stampLayout
	Trigger    string     `json:"trigger"` // schedule|manual
	Slot       *time.Time `json:"slot,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Status     string     `json:"status"`            // running|success|failed|cancelled
	Current    string     `json:"current,omitempty"` // database being written, while running
	Error      string     `json:"error,omitempty"`
	Path       string     `json:"path,omitempty"` // "YYYY/MM/<stamp>", success only
	Databases  []DBResult `json:"databases"`
	Warnings   []string   `json:"warnings,omitempty"`
	TotalBytes int64      `json:"total_bytes"`
	Version    string     `json:"app_version"`
}

// runPath is a run's published folder, relative to the backup dir.
func runPath(stamp time.Time) string {
	stamp = stamp.UTC()
	return filepath.Join(stamp.Format("2006"), stamp.Format("01"), stamp.Format(stampLayout))
}

// AppendHistory adds r to history.jsonl, keeping the newest historyLimit lines.
func AppendHistory(dir string, r Run) error {
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(dir, historyFile))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("backup: read history: %w", err)
	}
	lines := append(bytes.Split(bytes.TrimSpace(raw), []byte("\n")), line)
	lines = slices.DeleteFunc(lines, func(l []byte) bool { return len(l) == 0 })
	if len(lines) > historyLimit {
		lines = lines[len(lines)-historyLimit:]
	}
	return writeAtomic(filepath.Join(dir, historyFile), append(bytes.Join(lines, []byte("\n")), '\n'))
}

// ReadHistory returns the runs, newest first; an unparsable line is skipped.
func ReadHistory(dir string) ([]Run, error) {
	raw, err := os.ReadFile(filepath.Join(dir, historyFile))
	if errors.Is(err, fs.ErrNotExist) {
		return []Run{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("backup: read history: %w", err)
	}
	runs := []Run{}
	for _, l := range bytes.Split(raw, []byte("\n")) {
		var r Run
		if len(bytes.TrimSpace(l)) == 0 || json.Unmarshal(l, &r) != nil {
			continue
		}
		runs = append(runs, r)
	}
	slices.Reverse(runs)
	return runs, nil
}

// Published is a completed run folder on disk.
type Published struct {
	Path  string    `json:"path"`
	Stamp time.Time `json:"stamp"`
	Bytes int64     `json:"bytes"`
}

// ListPublished walks YYYY/MM/<stamp> folders, oldest first; anything else
// (.tmp, strays) is ignored.
func ListPublished(dir string) ([]Published, error) {
	dirs, err := filepath.Glob(filepath.Join(dir, "[0-9][0-9][0-9][0-9]", "[0-9][0-9]", "*"))
	if err != nil {
		return nil, err
	}
	out := []Published{}
	for _, p := range dirs {
		stamp, err := time.Parse(stampLayout, filepath.Base(p))
		if err != nil {
			continue
		}
		if info, err := os.Stat(p); err != nil || !info.IsDir() {
			continue
		}
		var size int64
		_ = filepath.WalkDir(p, func(_ string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				if info, err := d.Info(); err == nil {
					size += info.Size()
				}
			}
			return nil
		})
		rel, _ := filepath.Rel(dir, p)
		out = append(out, Published{Path: rel, Stamp: stamp, Bytes: size})
	}
	slices.SortFunc(out, func(a, b Published) int { return a.Stamp.Compare(b.Stamp) })
	return out, nil
}

// Retain deletes published runs older than `days`, never the newest one and
// never anything under .tmp; empty YYYY/MM parents go too. Each deletion is logged.
func Retain(dir string, days int, now time.Time, log *zap.Logger) ([]string, error) {
	pub, err := ListPublished(dir)
	if err != nil {
		return nil, err
	}
	cutoff := now.AddDate(0, 0, -days) // never overflows, unlike a Duration of days
	removed := []string{}
	for i, p := range pub {
		if i == len(pub)-1 || !p.Stamp.Before(cutoff) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, p.Path)); err != nil {
			return removed, fmt.Errorf("backup: remove %s: %w", p.Path, err)
		}
		log.Info("backup: removed expired bundle", zap.String("path", p.Path))
		removed = append(removed, p.Path)
		month := filepath.Dir(filepath.Join(dir, p.Path))
		_ = os.Remove(month)               // fails unless empty
		_ = os.Remove(filepath.Dir(month)) // same for the year
	}
	return removed, nil
}
