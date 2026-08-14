package cron

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestLogPathAndReadWrite(t *testing.T) {
	dir := t.TempDir()
	tenant, cronID, historyID := uuid.New(), uuid.New(), uuid.New()

	path := LogPath(dir, tenant, cronID, historyID)
	if filepath.Dir(path) != filepath.Join(dir, tenant.String()) {
		t.Fatalf("LogPath not namespaced by tenant: %s", path)
	}

	if err := WriteLog(path, "hello\n"); err != nil {
		t.Fatalf("WriteLog: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "hello\n" {
		t.Fatalf("content = %q, want %q", got, "hello\n")
	}

	if err := RemoveLog(path); err != nil {
		t.Fatalf("RemoveLog: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected log removed, stat err = %v", err)
	}
	// Removing again (already gone) must not error.
	if err := RemoveLog(path); err != nil {
		t.Fatalf("RemoveLog on missing file: %v", err)
	}
}
