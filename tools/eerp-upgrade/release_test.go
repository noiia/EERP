package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"core/internal/dbmanage"

	"github.com/jackc/pgx/v5"
)

func worktrees(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("git", "worktree", "list").CombinedOutput()
	if err != nil {
		t.Fatal(err, string(out))
	}
	return string(out)
}

func TestPrepareRelease_UnknownTag(t *testing.T) {
	before := worktrees(t)
	_, err := prepareRelease(context.Background(), "unused.json", "v0.0.0-nope")
	if err == nil || !strings.Contains(err.Error(), "v0.0.0-nope") {
		t.Fatalf("err = %v", err)
	}
	if after := worktrees(t); after != before {
		t.Fatalf("worktrees changed:\n%s\n%s", before, after)
	}
}

func TestPrepareRelease_TooOld(t *testing.T) {
	if _, err := prepareRelease(context.Background(), "unused.json", "v0.107.0"); err == nil || !strings.Contains(err.Error(), "older") {
		t.Fatalf("err = %v", err)
	}
}

func TestReleaseConfig(t *testing.T) {
	user := map[string]any{"db_host": "h", "master_key": "k", "s3_bucket": "b", "mcp_enabled": true, "module_root": []any{"x"}, "api_config_path": "api.json", "db_name": "old"}
	got := releaseConfig(user, "/cfg", "/w", "newdb", 4321)
	want := map[string]any{"db_name": "newdb", "environment": "production", "backend_port": 4321, "backend_host": "127.0.0.1",
		"module_root": []string{"/w/core/modules"}, "s3_bucket": "", "mcp_enabled": false, "cron_log_dir": "/w/cron-logs", "db_host": "h", "master_key": "k", "api_config_path": "/cfg/api.json"}
	for k, v := range want {
		if g := got[k]; !equalAny(g, v) {
			t.Errorf("%s = %#v, want %#v", k, g, v)
		}
	}
	for _, k := range []string{"s3_endpoint", "s3_access_key", "s3_secret_key", "nats_url", "redis_url", "smtp_host", "pdf_service_url", "frontend_base_url", "backup_dir", "mcp_oauth_issuer"} {
		if got[k] != "" {
			t.Errorf("%s = %#v, want empty", k, got[k])
		}
	}
	if user["db_name"] != "old" {
		t.Error("user config mutated")
	}
}

func equalAny(a, b any) bool {
	if x, ok := a.([]string); ok {
		y, _ := b.([]string)
		return len(x) == len(y) && len(x) == 1 && x[0] == y[0]
	}
	return a == b
}

func TestRelease_Migrate(t *testing.T) {
	cfgPath := os.Getenv("CONFIG")
	if os.Getenv("EERP_UPGRADE_SLOW") != "1" || cfgPath == "" {
		t.Skip("set EERP_UPGRADE_SLOW=1 and CONFIG")
	}
	cfg := testConfig(t)
	ctx := context.Background()
	r, err := prepareRelease(ctx, cfgPath, "v0.108.0")
	if err != nil {
		t.Fatal(err)
	}
	wt := r.worktree
	conn := dbmanage.ConnFromConfig(cfg)
	name := tmpName("t")
	if err := dbmanage.CreateDatabase(ctx, conn, name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbmanage.DropDatabase(context.Background(), conn, name, cfg.DbName) })
	if err := r.Migrate(ctx, name); err != nil {
		t.Fatal(err)
	}
	c, err := pgx.Connect(ctx, conn.DSN(name))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	for tbl, want := range map[string]bool{"users": true, "event": true, "project": false} {
		var ok bool
		if err := c.QueryRow(ctx, `SELECT to_regclass('public.'||$1) IS NOT NULL`, tbl).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		if ok != want {
			t.Errorf("table %s exists = %v, want %v", tbl, ok, want)
		}
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Errorf("worktree still there: %v", err)
	}
}
