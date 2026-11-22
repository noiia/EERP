package backup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"core/internal/notify"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

func init() { notify.RegisterCategory(notify.Category{Key: "backup", Label: "Backups"}) }

var (
	// ErrBusy: a run is already in progress (here or in another process).
	ErrBusy = errors.New("backup: a run is already in progress")
	// ErrNoDatabases: the settings select no database.
	ErrNoDatabases = errors.New("backup: no database is selected")
)

// Bundler writes one database's restorable zip (dbmanage.Manager).
type Bundler interface {
	WriteBundle(ctx context.Context, w io.Writer, db string, includeS3 bool) (int, error)
	DatabaseNames(ctx context.Context) ([]string, error)
}

// Notifier is what a run needs from internal/notify (nil = no notifications).
type Notifier interface {
	Start(ctx context.Context, tenant uuid.UUID, a notify.Activity) (*notify.Run, error)
}

// Service runs backups into dir, one at a time.
type Service struct {
	dir      string
	bundler  Bundler
	locker   Locker
	notifier Notifier
	version  string
	log      *zap.Logger

	mu       sync.Mutex
	starting bool // a Start is taking the lock
	current  *Run
	cancel   context.CancelFunc
	done     chan struct{}
}

// NewService builds a Service writing into dir (Config.BackupDir).
func NewService(dir string, b Bundler, l Locker, n Notifier, version string, log *zap.Logger) *Service {
	return &Service{dir: dir, bundler: b, locker: l, notifier: n, version: version, log: log}
}

// Dir is the backup folder.
func (s *Service) Dir() string { return s.dir }

// Current is the run in progress in this process, or nil.
func (s *Service) Current() *Run {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil {
		return nil
	}
	r := *s.current
	return &r
}

// Cancel stops the run in progress; false when nothing runs here.
func (s *Service) Cancel() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel == nil {
		return false
	}
	s.cancel()
	return true
}

// lockTimeout bounds taking the cross-process lock (a new Postgres connection).
const lockTimeout = 15 * time.Second

// Start launches a run in the background and returns it as started.
// tenant/user (uuid.Nil = none) receive its notification. The slot is reserved
// under s.mu, but the lock — a network call — is taken outside it, so a slow
// or unreachable Postgres never blocks Current/Cancel (the status page).
func (s *Service) Start(trigger string, slot *time.Time, tenant, user uuid.UUID) (Run, error) {
	s.mu.Lock()
	if s.current != nil || s.starting {
		s.mu.Unlock()
		return Run{}, ErrBusy
	}
	s.starting = true
	s.mu.Unlock()
	reserved := true
	defer func() {
		if reserved {
			s.mu.Lock()
			s.starting = false
			s.mu.Unlock()
		}
	}()

	settings, err := LoadSettings(s.dir)
	if err != nil {
		return Run{}, err
	}
	if len(settings.Databases) == 0 {
		return Run{}, ErrNoDatabases
	}
	lockCtx, cancelLock := context.WithTimeout(context.Background(), lockTimeout)
	unlock, ok, err := s.locker.TryLock(lockCtx)
	cancelLock()
	if err != nil {
		return Run{}, err
	}
	if !ok {
		return Run{}, ErrBusy
	}

	start := time.Now().UTC().Truncate(time.Second)
	run := Run{ID: start.Format(stampLayout), Trigger: trigger, Slot: slot, StartedAt: start,
		Status: "running", Databases: []DBResult{}, Version: s.version}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.starting, reserved = false, false
	current := run // the service's own copy: execute's progress writes never touch the returned value
	s.current, s.cancel, s.done = &current, cancel, make(chan struct{})
	go s.execute(ctx, run, settings, unlock, tenant, user, s.done)
	s.mu.Unlock()
	return run, nil
}

func (s *Service) execute(ctx context.Context, run Run, settings Settings, unlock func(), tenant, user uuid.UUID, done chan struct{}) {
	defer func() {
		unlock()
		s.mu.Lock()
		s.cancel()
		s.current, s.cancel, s.done = nil, nil, nil
		s.mu.Unlock()
		close(done)
	}()

	var activity *notify.Run
	if s.notifier != nil && tenant != uuid.Nil {
		a := notify.Activity{Category: "backup", Title: "Backup " + run.ID, Link: "/settings/developer"}
		if user != uuid.Nil {
			a.ActorID = &user
		}
		if activity, _ = s.notifier.Start(context.Background(), tenant, a); activity == nil {
			s.log.Warn("backup: could not start its notification", zap.String("run", run.ID))
		}
	}

	err := s.build(ctx, &run, settings, activity)
	finished := time.Now().UTC()
	run.FinishedAt = &finished
	switch {
	case ctx.Err() != nil:
		run.Status, run.Error = "cancelled", "cancelled"
		err = errors.New("cancelled")
	case err != nil:
		run.Status, run.Error = "failed", err.Error()
	default:
		run.Status = "success"
	}
	if err := AppendHistory(s.dir, run); err != nil {
		s.log.Error("backup: record history", zap.String("run", run.ID), zap.Error(err))
	}
	if run.Status == "success" {
		s.log.Info("backup: published", zap.String("run", run.ID), zap.String("path", run.Path),
			zap.Int64("bytes", run.TotalBytes))
		if _, err := Retain(s.dir, settings.RetentionDays, finished, s.log); err != nil {
			s.log.Warn("backup: retention", zap.Error(err))
		}
	} else {
		s.log.Warn("backup: run did not complete", zap.String("run", run.ID), zap.String("status", run.Status),
			zap.String("error", run.Error))
	}
	if activity != nil {
		activity.Finish(err, "", nil)
	}
}

// build writes every selected database into .tmp/<id>, validates the files,
// writes manifest.json and renames the folder into YYYY/MM/<id> — the only
// step that makes it visible. On any error the temp folder is removed.
func (s *Service) build(ctx context.Context, run *Run, settings Settings, activity *notify.Run) (err error) {
	tmp := filepath.Join(s.dir, tmpDir, run.ID)
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return fmt.Errorf("create temp folder: %w", err)
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(tmp)
		}
	}()

	existing, err := s.bundler.DatabaseNames(ctx)
	if err != nil {
		return fmt.Errorf("list databases: %w", err)
	}
	for i, db := range settings.Databases {
		if !slices.Contains(existing, db) {
			run.Warnings = append(run.Warnings, fmt.Sprintf("database %q no longer exists: skipped", db))
			continue
		}
		s.setProgress(run, db)
		if activity != nil {
			activity.Progress(i*100/len(settings.Databases), db)
		}
		res, err := s.writeZip(ctx, tmp, db, settings.IncludeS3)
		if err != nil {
			return fmt.Errorf("%s: %w", db, err)
		}
		run.Databases = append(run.Databases, res)
		run.TotalBytes += res.Size
	}
	if len(run.Databases) == 0 {
		return errors.New("none of the selected databases exists")
	}

	finished := time.Now().UTC()
	manifest, _ := json.MarshalIndent(struct {
		ID         string     `json:"id"`
		Version    string     `json:"app_version"`
		Trigger    string     `json:"trigger"`
		StartedAt  time.Time  `json:"started_at"`
		FinishedAt time.Time  `json:"finished_at"`
		Databases  []DBResult `json:"databases"`
		Warnings   []string   `json:"warnings,omitempty"`
		TotalBytes int64      `json:"total_bytes"`
	}{run.ID, run.Version, run.Trigger, run.StartedAt, finished, run.Databases, run.Warnings, run.TotalBytes}, "", "  ")
	if err := writeAtomic(filepath.Join(tmp, "manifest.json"), manifest); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	rel := runPath(run.StartedAt)
	final := filepath.Join(s.dir, rel)
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(rel), err)
	}
	if _, err := os.Stat(final); err == nil {
		return fmt.Errorf("%s already exists", rel)
	}
	// tmp and final share the backup dir's filesystem: rename is atomic.
	if err := os.Rename(tmp, final); err != nil {
		return fmt.Errorf("publish: %w", err)
	}
	run.Path = rel
	return nil
}

func (s *Service) setProgress(run *Run, db string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current != nil {
		s.current.Databases = slices.Clone(run.Databases)
		s.current.Warnings = slices.Clone(run.Warnings)
		s.current.TotalBytes = run.TotalBytes
		s.current.Current = db
	}
}

// writeZip writes db's bundle to dir/<db>.zip, then checks it reads back as a
// zip holding dump.dump.
func (s *Service) writeZip(ctx context.Context, dir, db string, includeS3 bool) (DBResult, error) {
	name := db + ".zip"
	path := filepath.Join(dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return DBResult{}, err
	}
	h := sha256.New()
	objects, err := s.bundler.WriteBundle(ctx, io.MultiWriter(f, h), db, includeS3)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return DBResult{}, err
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return DBResult{}, fmt.Errorf("unreadable zip: %w", err)
	}
	hasDump := slices.ContainsFunc(zr.File, func(f *zip.File) bool { return f.Name == "dump.dump" })
	_ = zr.Close()
	if !hasDump {
		return DBResult{}, errors.New("zip has no dump.dump")
	}
	info, err := os.Stat(path)
	if err != nil {
		return DBResult{}, err
	}
	return DBResult{Name: db, File: name, Size: info.Size(), SHA256: hex.EncodeToString(h.Sum(nil)), S3Objects: objects}, nil
}

// CleanupStale removes leftovers of runs a dead process left in .tmp — only
// while holding the lock, so another process's live run is never touched.
func (s *Service) CleanupStale(ctx context.Context) error {
	unlock, ok, err := s.locker.TryLock(ctx)
	if err != nil || !ok {
		return err
	}
	defer unlock()
	return os.RemoveAll(filepath.Join(s.dir, tmpDir))
}

// anchor is where the schedule counts from: the last scheduled run's slot,
// or the last settings save if later (editing the schedule restarts it).
func (s *Service) anchor(settings Settings) time.Time {
	anchor := settings.UpdatedAt
	runs, _ := ReadHistory(s.dir)
	for _, r := range runs {
		if r.Trigger == "schedule" && r.Slot != nil {
			if r.Slot.After(anchor) {
				anchor = *r.Slot
			}
			break
		}
	}
	return anchor
}

// NextRun is the next scheduled run, nil when the scheduler is off.
func (s *Service) NextRun(now time.Time) *time.Time {
	settings, err := LoadSettings(s.dir)
	if err != nil || !settings.Enabled || settings.Validate(settings.Databases) != nil {
		return nil
	}
	next := NextSlot(settings, s.anchor(settings))
	return &next
}

// Tick starts the scheduled run when one is due. Slots missed while the
// server was down collapse into one run, for the latest of them.
func (s *Service) Tick(ctx context.Context, now time.Time) {
	settings, err := LoadSettings(s.dir)
	if err != nil {
		s.log.Warn("backup: settings", zap.Error(err))
		return
	}
	if !settings.Enabled || settings.Validate(settings.Databases) != nil {
		return
	}
	slot := NextSlot(settings, s.anchor(settings))
	if slot.After(now) {
		return
	}
	for next := NextSlot(settings, slot); !next.After(now); next = NextSlot(settings, slot) {
		slot = next
	}
	if _, err := s.Start("schedule", &slot, settings.NotifyTenant, settings.NotifyUser); err != nil && !errors.Is(err, ErrBusy) {
		s.log.Warn("backup: scheduled run did not start", zap.Error(err))
	}
}

// Run cleans stale temp folders, then ticks every minute until ctx ends; a
// run in progress is then cancelled and awaited (its temp folder removed).
func (s *Service) Run(ctx context.Context) {
	if err := s.CleanupStale(ctx); err != nil {
		s.log.Warn("backup: clean stale temp folders", zap.Error(err))
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			done := s.done
			s.mu.Unlock()
			if s.Cancel() && done != nil {
				<-done
			}
			return
		case now := <-ticker.C:
			s.Tick(ctx, now)
		}
	}
}
