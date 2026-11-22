// Package backup generates scheduled, atomic backup bundles of the selected
// EERP databases into Config.BackupDir — the folder an external tool
// (Backrest/Restic) snapshots. Everything it keeps lives in that folder as
// files (settings, history, published bundles): no table in any EERP
// database, since dbmanage switches, deletes and restores those. See
// docs/adr/ADR-044-automated-backups.md.
package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"time"
	_ "time/tzdata" // timezones work even in images without /usr/share/zoneinfo

	"github.com/google/uuid"
)

const settingsFile = "backup-config.json"

// Settings is the scheduler's configuration (backup-config.json).
type Settings struct {
	Enabled       bool      `json:"enabled"`
	Frequency     string    `json:"frequency"` // hours|daily|weekly|monthly
	EveryHours    int       `json:"every_hours"`
	Time          string    `json:"time"` // HH:MM, local to Timezone
	Timezone      string    `json:"timezone"`
	Weekdays      []int     `json:"weekdays"` // 0 = Sunday
	MonthDay      int       `json:"month_day"`
	Databases     []string  `json:"databases"`
	IncludeS3     bool      `json:"include_s3"`
	RetentionDays int       `json:"retention_days"`
	UpdatedAt     time.Time `json:"updated_at"`
	// Who last saved the settings: scheduled runs report to their notification bell.
	NotifyTenant uuid.UUID `json:"notify_tenant_id"`
	NotifyUser   uuid.UUID `json:"notify_user_id"`
}

// Defaults is what a server with no backup-config.json reads.
func Defaults() Settings {
	return Settings{Frequency: "daily", EveryHours: 24, Time: "02:00", Timezone: "UTC",
		MonthDay: 1, IncludeS3: true, RetentionDays: 14}
}

var timeRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// Validate checks s; known lists the databases that exist on the server.
func (s Settings) Validate(known []string) error {
	switch s.Frequency {
	case "hours":
		if s.EveryHours < 1 || s.EveryHours > 168 {
			return errors.New("every_hours must be between 1 and 168")
		}
	case "daily":
	case "weekly":
		if len(s.Weekdays) == 0 {
			return errors.New("weekly backups need at least one weekday")
		}
		for _, d := range s.Weekdays {
			if d < 0 || d > 6 {
				return errors.New("weekdays must be between 0 (Sunday) and 6")
			}
		}
	case "monthly":
		if s.MonthDay < 1 || s.MonthDay > 28 {
			return errors.New("month_day must be between 1 and 28")
		}
	default:
		return errors.New("frequency must be hours, daily, weekly or monthly")
	}
	if !timeRe.MatchString(s.Time) {
		return errors.New("time must be HH:MM")
	}
	if s.Timezone == "" {
		return errors.New("timezone is required")
	}
	if _, err := time.LoadLocation(s.Timezone); err != nil {
		return fmt.Errorf("unknown timezone %q", s.Timezone)
	}
	if s.RetentionDays < 1 || s.RetentionDays > 3650 {
		return errors.New("retention_days must be between 1 and 3650")
	}
	if s.Enabled && len(s.Databases) == 0 {
		return errors.New("select at least one database")
	}
	seen := map[string]bool{}
	for _, db := range s.Databases {
		if seen[db] {
			return fmt.Errorf("database %q is listed twice", db)
		}
		seen[db] = true
		if !slices.Contains(known, db) {
			return fmt.Errorf("unknown database %q", db)
		}
	}
	return nil
}

// LoadSettings reads dir's settings; a missing file reads as Defaults().
func LoadSettings(dir string) (Settings, error) {
	raw, err := os.ReadFile(filepath.Join(dir, settingsFile))
	if errors.Is(err, os.ErrNotExist) {
		return Defaults(), nil
	}
	if err != nil {
		return Settings{}, fmt.Errorf("backup: read settings: %w", err)
	}
	s := Defaults()
	if err := json.Unmarshal(raw, &s); err != nil {
		return Settings{}, fmt.Errorf("backup: parse settings: %w", err)
	}
	return s, nil
}

// SaveSettings replaces dir's settings atomically.
func SaveSettings(dir string, s Settings) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, settingsFile), raw)
}

// writeAtomic writes path through a temp file in the same directory, fsync'd,
// then renamed over it: a reader sees the old file or the new one, never half.
func writeAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return fmt.Errorf("backup: write %s: %w", filepath.Base(path), err)
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("backup: write %s: %w", filepath.Base(path), err)
	}
	return nil
}
