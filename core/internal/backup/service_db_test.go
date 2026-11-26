package backup_test

import (
	"archive/zip"
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"core/internal/backup"
	"core/internal/dbmanage"
	"core/internal/testdb"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

func maintenance(t *testing.T) func(context.Context) (*pgx.Conn, error) {
	cfg := *testdb.Config(t)
	cfg.DbName = "postgres"
	dsn := cfg.DSN()
	return func(ctx context.Context) (*pgx.Conn, error) { return pgx.Connect(ctx, dsn) }
}

func TestPGLocker_Exclusive(t *testing.T) {
	ctx := context.Background()
	a, b := backup.PGLocker(maintenance(t)), backup.PGLocker(maintenance(t))
	unlock, ok, err := a.TryLock(ctx)
	if err != nil || !ok {
		t.Fatalf("first lock: ok=%v err=%v", ok, err)
	}
	if _, ok, err := b.TryLock(ctx); err != nil || ok {
		t.Fatalf("second lock while held: ok=%v err=%v", ok, err)
	}
	unlock()
	unlock2, ok, err := b.TryLock(ctx)
	if err != nil || !ok {
		t.Fatalf("lock after release: ok=%v err=%v", ok, err)
	}
	unlock2()

	bad := backup.PGLocker(func(context.Context) (*pgx.Conn, error) { return nil, context.Canceled })
	if _, _, err := bad.TryLock(ctx); err == nil {
		t.Error("an unreachable server: want an error")
	}
}

// One real run: pg_dump into a published, readable zip.
func TestRun_RealDatabase(t *testing.T) {
	if _, err := exec.LookPath("pg_dump"); err != nil {
		t.Skip("pg_dump not installed")
	}
	cfg := testdb.Config(t)
	app := testdb.Open(t)
	mgr := dbmanage.NewManager(app, nil, nil, nil, nil, cfg, "")
	dir := t.TempDir()
	s := backup.Defaults()
	s.Databases, s.IncludeS3 = []string{cfg.DbName}, false
	if err := backup.SaveSettings(dir, s); err != nil {
		t.Fatal(err)
	}
	svc := backup.NewService(dir, mgr, backup.PGLocker(mgr.MaintenanceConn), nil, "test", zap.NewNop())
	if _, err := svc.Start("manual", nil, uuid.Nil, uuid.Nil); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(2 * time.Minute); svc.Current() != nil; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("run never finished")
		}
	}
	runs, _ := backup.ReadHistory(dir)
	if len(runs) != 1 || runs[0].Status != "success" {
		t.Fatalf("runs = %+v", runs)
	}
	zr, err := zip.OpenReader(filepath.Join(dir, runs[0].Path, cfg.DbName+".zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = zr.Close() }()
	entries := map[string]uint64{}
	for _, f := range zr.File {
		entries[f.Name] = f.UncompressedSize64
	}
	if len(entries) != 2 || entries["dump.dump"] == 0 || entries["version.json"] == 0 {
		t.Errorf("zip entries = %v, want dump.dump and version.json", entries)
	}
}
