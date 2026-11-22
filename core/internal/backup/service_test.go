package backup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// fakeBundler writes a minimal valid bundle; gate (when set) blocks each
// write until closed or the run is cancelled; fail names a database that errors.
type fakeBundler struct {
	dbs  []string
	gate chan struct{}
	fail string
	err  error
}

func (f *fakeBundler) DatabaseNames(context.Context) ([]string, error) { return f.dbs, nil }

func (f *fakeBundler) WriteBundle(ctx context.Context, w io.Writer, db string, _ bool) (int, error) {
	if db == f.fail {
		return 0, f.err
	}
	zw := zip.NewWriter(w)
	e, _ := zw.Create("dump.dump")
	_, _ = io.WriteString(e, "DUMP:"+db)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	return 2, zw.Close()
}

type fakeLocker struct {
	mu   sync.Mutex
	held bool
}

func (l *fakeLocker) TryLock(context.Context) (func(), bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.held {
		return nil, false, nil
	}
	l.held = true
	return func() { l.mu.Lock(); l.held = false; l.mu.Unlock() }, true, nil
}

func newService(t *testing.T, b Bundler, dbs ...string) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	s := Defaults()
	s.Databases = dbs
	if err := SaveSettings(dir, s); err != nil {
		t.Fatal(err)
	}
	return NewService(dir, b, &fakeLocker{}, nil, "test", zap.NewNop()), dir
}

func waitIdle(t *testing.T, s *Service) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for s.Current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("run never finished")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func lastRun(t *testing.T, dir string) Run {
	t.Helper()
	runs, err := ReadHistory(dir)
	if err != nil || len(runs) == 0 {
		t.Fatalf("history: %v %v", runs, err)
	}
	return runs[0]
}

func tmpEntries(dir string) int {
	e, _ := os.ReadDir(filepath.Join(dir, tmpDir))
	return len(e)
}

func TestRun_PublishesAtomically(t *testing.T) {
	b := &fakeBundler{dbs: []string{"poc", "client_a"}, gate: make(chan struct{})}
	svc, dir := newService(t, b, "poc", "client_a")
	run, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if pub, _ := ListPublished(dir); len(pub) != 0 {
		t.Fatalf("published while running: %v", pub)
	}
	if _, err := os.Stat(filepath.Join(dir, tmpDir, run.ID)); err != nil {
		t.Fatalf("no temp folder while running: %v", err)
	}
	close(b.gate)
	waitIdle(t, svc)

	got := lastRun(t, dir)
	if got.Status != "success" || got.Path == "" || len(got.Databases) != 2 || got.TotalBytes == 0 {
		t.Fatalf("run = %+v", got)
	}
	pub, _ := ListPublished(dir)
	if len(pub) != 1 || pub[0].Path != got.Path || tmpEntries(dir) != 0 {
		t.Fatalf("published %v, tmp %d", pub, tmpEntries(dir))
	}
	var manifest Run
	raw, err := os.ReadFile(filepath.Join(dir, got.Path, "manifest.json"))
	if err != nil || json.Unmarshal(raw, &manifest) != nil {
		t.Fatalf("manifest: %v", err)
	}
	for _, d := range manifest.Databases {
		zipBytes, err := os.ReadFile(filepath.Join(dir, got.Path, d.File))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(zipBytes)
		if d.File != d.Name+".zip" || d.SHA256 != hex.EncodeToString(sum[:]) || d.Size != int64(len(zipBytes)) || d.S3Objects != 2 {
			t.Errorf("manifest entry %+v does not match the file", d)
		}
	}
	if manifest.ID != got.ID || manifest.Version != "test" {
		t.Errorf("manifest = %+v", manifest)
	}
}

func TestRun_FailureLeavesNothingPublished(t *testing.T) {
	b := &fakeBundler{dbs: []string{"poc", "client_a"}, fail: "client_a", err: errors.New("disk full")}
	svc, dir := newService(t, b, "poc", "client_a")
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, svc)
	got := lastRun(t, dir)
	if got.Status != "failed" || !strings.Contains(got.Error, "disk full") {
		t.Errorf("run = %+v", got)
	}
	if pub, _ := ListPublished(dir); len(pub) != 0 || tmpEntries(dir) != 0 {
		t.Errorf("published %v, tmp %d", pub, tmpEntries(dir))
	}
}

func TestRun_ConcurrentRejected(t *testing.T) {
	b := &fakeBundler{dbs: []string{"poc"}, gate: make(chan struct{})}
	svc, dir := newService(t, b, "poc")
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); !errors.Is(err, ErrBusy) {
		t.Errorf("second start: %v, want ErrBusy", err)
	}
	close(b.gate)
	waitIdle(t, svc)

	// Another process holds the lock.
	locked := &fakeLocker{held: true}
	other := NewService(dir, b, locked, nil, "test", zap.NewNop())
	if _, err := other.Start("manual", nil, uuid.Nil, uuid.Nil); !errors.Is(err, ErrBusy) {
		t.Errorf("locked elsewhere: %v, want ErrBusy", err)
	}
}

func TestCancel(t *testing.T) {
	b := &fakeBundler{dbs: []string{"poc"}, gate: make(chan struct{})}
	svc, dir := newService(t, b, "poc")
	if svc.Cancel() {
		t.Error("cancel with nothing running reported true")
	}
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	if !svc.Cancel() {
		t.Error("cancel reported false")
	}
	waitIdle(t, svc)
	if got := lastRun(t, dir); got.Status != "cancelled" {
		t.Errorf("run = %+v", got)
	}
	if pub, _ := ListPublished(dir); len(pub) != 0 || tmpEntries(dir) != 0 {
		t.Errorf("published %v, tmp %d", pub, tmpEntries(dir))
	}
}

func TestRun_MissingDatabaseIsWarning(t *testing.T) {
	svc, dir := newService(t, &fakeBundler{dbs: []string{"poc"}}, "poc", "gone")
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, svc)
	got := lastRun(t, dir)
	if got.Status != "success" || len(got.Databases) != 1 || len(got.Warnings) != 1 || !strings.Contains(got.Warnings[0], "gone") {
		t.Errorf("run = %+v", got)
	}

	// Every selected database gone: a failure, not an empty bundle.
	svc2, dir2 := newService(t, &fakeBundler{dbs: []string{"poc"}}, "gone")
	if _, err := svc2.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, svc2)
	if got := lastRun(t, dir2); got.Status != "failed" {
		t.Errorf("run = %+v", got)
	}
}

func TestRun_S3RequestedWithoutStore(t *testing.T) {
	noStore := errors.New("dbmanage: S3 content was requested but this instance has no s3_* object store configured")
	svc, dir := newService(t, &fakeBundler{dbs: []string{"poc"}, fail: "poc", err: noStore}, "poc")
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, svc)
	if got := lastRun(t, dir); got.Status != "failed" || !strings.Contains(got.Error, "no s3_*") {
		t.Errorf("run = %+v", got)
	}
}

func TestRun_NoDatabasesSelected(t *testing.T) {
	svc, _ := newService(t, &fakeBundler{})
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); !errors.Is(err, ErrNoDatabases) {
		t.Errorf("err = %v, want ErrNoDatabases", err)
	}
}

func TestCleanupStale_SkipsWhenLocked(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, tmpDir, "2026-01-01T000000Z")
	_ = os.MkdirAll(stale, 0o700)
	locked := NewService(dir, &fakeBundler{}, &fakeLocker{held: true}, nil, "test", zap.NewNop())
	if err := locked.CleanupStale(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); err != nil {
		t.Fatal("removed while another process holds the lock")
	}
	free := NewService(dir, &fakeBundler{}, &fakeLocker{}, nil, "test", zap.NewNop())
	if err := free.CleanupStale(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale temp folder kept")
	}
}

func TestTick_RunsOnceForMissedSlots(t *testing.T) {
	svc, dir := newService(t, &fakeBundler{dbs: []string{"poc"}}, "poc")
	now := time.Date(2026, 11, 22, 9, 0, 0, 0, time.UTC)
	s, _ := LoadSettings(dir)
	s.Enabled, s.UpdatedAt, s.NotifyTenant = true, now.Add(-72*time.Hour), uuid.Nil
	_ = SaveSettings(dir, s)

	svc.Tick(context.Background(), now)
	waitIdle(t, svc)
	runs, _ := ReadHistory(dir)
	want := time.Date(2026, 11, 22, 2, 0, 0, 0, time.UTC)
	if len(runs) != 1 || runs[0].Trigger != "schedule" || runs[0].Slot == nil || !runs[0].Slot.Equal(want) {
		t.Fatalf("runs = %+v", runs)
	}
	svc.Tick(context.Background(), now.Add(time.Minute))
	waitIdle(t, svc)
	if runs, _ := ReadHistory(dir); len(runs) != 1 {
		t.Errorf("a second run for the same slot: %d runs", len(runs))
	}

	// Disabled: nothing runs, even when due.
	s.Enabled = false
	_ = SaveSettings(dir, s)
	svc.Tick(context.Background(), now.Add(48*time.Hour))
	waitIdle(t, svc)
	if runs, _ := ReadHistory(dir); len(runs) != 1 {
		t.Errorf("disabled scheduler ran: %d runs", len(runs))
	}
}

func TestNextRun(t *testing.T) {
	svc, dir := newService(t, &fakeBundler{dbs: []string{"poc"}}, "poc")
	now := time.Date(2026, 11, 22, 9, 0, 0, 0, time.UTC)
	if svc.NextRun(now) != nil {
		t.Error("disabled scheduler has a next run")
	}
	s, _ := LoadSettings(dir)
	s.Enabled, s.UpdatedAt = true, now
	_ = SaveSettings(dir, s)
	if got := svc.NextRun(now); got == nil || !got.Equal(time.Date(2026, 11, 23, 2, 0, 0, 0, time.UTC)) {
		t.Errorf("next = %v", got)
	}
}

// slowLocker hangs in TryLock until release is closed (an unreachable Postgres).
type slowLocker struct{ release chan struct{} }

func (l *slowLocker) TryLock(ctx context.Context) (func(), bool, error) {
	select {
	case <-l.release:
		return func() {}, true, nil
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}
}

// A hanging lock call must not freeze Current/Cancel (the status page), and a
// second start meanwhile is refused at once.
func TestStart_SlowLockDoesNotBlockStatus(t *testing.T) {
	dir := t.TempDir()
	s := Defaults()
	s.Databases = []string{"poc"}
	_ = SaveSettings(dir, s)
	lock := &slowLocker{release: make(chan struct{})}
	svc := NewService(dir, &fakeBundler{dbs: []string{"poc"}}, lock, nil, "test", zap.NewNop())
	started := make(chan error, 1)
	go func() { _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); started <- err }()
	time.Sleep(20 * time.Millisecond)

	answered := make(chan struct{})
	go func() {
		_ = svc.Current()
		_ = svc.Cancel()
		if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); !errors.Is(err, ErrBusy) {
			t.Errorf("start while another is starting: %v, want ErrBusy", err)
		}
		close(answered)
	}()
	select {
	case <-answered:
	case <-time.After(time.Second):
		t.Fatal("Current/Cancel/Start blocked behind the lock call")
	}
	close(lock.release)
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	waitIdle(t, svc)
}
