package backup

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestHistory_TrimTo500(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range 502 {
		if err := AppendHistory(dir, Run{ID: fmt.Sprint(i), Status: "success", StartedAt: base.Add(time.Duration(i) * time.Minute)}); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := ReadHistory(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 500 || runs[0].ID != "501" || runs[499].ID != "2" {
		t.Errorf("len=%d first=%s last=%s", len(runs), runs[0].ID, runs[len(runs)-1].ID)
	}
}

func TestHistory_SkipsCorruptLine(t *testing.T) {
	dir := t.TempDir()
	_ = AppendHistory(dir, Run{ID: "a"})
	f, _ := os.OpenFile(filepath.Join(dir, historyFile), os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString("{broken\n")
	_ = f.Close()
	_ = AppendHistory(dir, Run{ID: "b"})
	runs, err := ReadHistory(dir)
	if err != nil || len(runs) != 2 || runs[0].ID != "b" {
		t.Errorf("runs=%v err=%v", runs, err)
	}
	if runs, err := ReadHistory(t.TempDir()); err != nil || len(runs) != 0 {
		t.Errorf("missing history: %v %v", runs, err)
	}
}

// publish makes a fake published run folder aged `age` before now.
func publish(t *testing.T, dir string, now time.Time, age time.Duration) string {
	t.Helper()
	stamp := now.Add(-age).UTC()
	rel := runPath(stamp)
	if err := os.MkdirAll(filepath.Join(dir, rel), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, rel, "poc.zip"), []byte("12345"), 0o600)
	return rel
}

func TestListPublished_IgnoresTmpAndStrays(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 22, 2, 0, 0, 0, time.UTC)
	rel := publish(t, dir, now, 0)
	_ = os.MkdirAll(filepath.Join(dir, ".tmp", "2026-11-22T020000Z"), 0o700)
	_ = os.MkdirAll(filepath.Join(dir, "2026", "11", "not-a-stamp"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "2026", "stray.txt"), nil, 0o600)
	got, err := ListPublished(dir)
	if err != nil || len(got) != 1 || got[0].Path != rel || got[0].Bytes != 5 || !got[0].Stamp.Equal(now) {
		t.Errorf("got %+v, %v", got, err)
	}
}

func TestRetention_RemovesOld(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 22, 2, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	keep := publish(t, dir, now, day)
	old1 := publish(t, dir, now, 20*day)
	old2 := publish(t, dir, now, 40*day)
	removed, err := Retain(dir, 14, now, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(removed)
	want := []string{old1, old2}
	slices.Sort(want)
	if !slices.Equal(removed, want) {
		t.Errorf("removed %v, want %v", removed, want)
	}
	left, _ := ListPublished(dir)
	if len(left) != 1 || left[0].Path != keep {
		t.Errorf("left %+v", left)
	}
}

func TestRetention_KeepsNewest(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 22, 2, 0, 0, 0, time.UTC)
	publish(t, dir, now, 41*24*time.Hour)
	newest := publish(t, dir, now, 40*24*time.Hour)
	if _, err := Retain(dir, 14, now, zap.NewNop()); err != nil {
		t.Fatal(err)
	}
	left, _ := ListPublished(dir)
	if len(left) != 1 || left[0].Path != newest {
		t.Errorf("left %+v, want only %s", left, newest)
	}
}

func TestRetention_NeverTouchesTmp(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 22, 2, 0, 0, 0, time.UTC)
	tmp := filepath.Join(dir, ".tmp", "2025-01-01T000000Z")
	_ = os.MkdirAll(tmp, 0o700)
	old := time.Now().Add(-400 * 24 * time.Hour)
	_ = os.Chtimes(tmp, old, old)
	publish(t, dir, now, 0)
	if _, err := Retain(dir, 1, now, zap.NewNop()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tmp); err != nil {
		t.Errorf(".tmp entry removed: %v", err)
	}
}

// A huge retention must keep everything, never wrap into "all expired".
func TestRetention_HugeDaysKeepsAll(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 22, 2, 0, 0, 0, time.UTC)
	publish(t, dir, now, 24*time.Hour)
	publish(t, dir, now, 0)
	removed, err := Retain(dir, 999999, now, zap.NewNop())
	if err != nil || len(removed) != 0 {
		t.Errorf("removed %v, %v", removed, err)
	}
}
