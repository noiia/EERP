package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// release boots a past EERP release against a database so that release's own
// migrations bring it to its schema. The release is built from a git worktree.
type release struct {
	tag, version, worktree, bin string
	cfg                         map[string]any
}

const healthTimeout = 5 * time.Minute

func gitOut(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func prepareRelease(ctx context.Context, cfgPath, tag string) (*release, error) {
	ver := strings.TrimPrefix(tag, "v")
	// A tag that doesn't parse falls through to git's "unknown tag".
	if c, err := compareVersions(ver, floor); err == nil && c < 0 {
		return nil, fmt.Errorf("-to %s is older than the oldest supported release %s", tag, floor)
	}
	root, err := gitOut(ctx, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fmt.Errorf("run from an EERP git checkout: %s", root)
	}
	if _, err := gitOut(ctx, "-C", root, "rev-parse", "--verify", "--quiet", "refs/tags/"+tag); err != nil {
		return nil, fmt.Errorf("unknown release tag %s (is it fetched? git fetch --tags)", tag)
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return nil, err
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("read %s: %w", cfgPath, err)
	}
	wt, err := os.MkdirTemp("", "eerp-release-")
	if err != nil {
		return nil, err
	}
	r := &release{tag: tag, version: ver, worktree: wt, bin: filepath.Join(wt, "eerp"), cfg: cfg}
	// worktree add needs a missing or empty dir; MkdirTemp's empty dir is accepted.
	if out, err := gitOut(ctx, "-C", root, "worktree", "add", "--detach", wt, tag); err != nil {
		os.RemoveAll(wt)
		return nil, fmt.Errorf("git worktree add: %s", out)
	}
	build := exec.CommandContext(ctx, "go", "build", "-C", filepath.Join(wt, "core"),
		"-ldflags", "-X core/internal/version.Version="+ver, "-o", r.bin, "./cmd/app")
	if out, err := build.CombinedOutput(); err != nil {
		_ = r.Close()
		return nil, fmt.Errorf("build %s: %w\n%s", tag, err, out)
	}
	return r, nil
}

func (r *release) Close() error {
	if out, err := gitOut(context.WithoutCancel(context.Background()), "worktree", "remove", "--force", r.worktree); err != nil {
		return fmt.Errorf("git worktree remove: %s", out)
	}
	return nil
}

func (r *release) Version() string { return r.version }

// releaseConfig derives the old release's config: this database, a private
// listener, and every external service off. Unknown keys are ignored by old cores.
func releaseConfig(user map[string]any, worktree, dbName string, port int) map[string]any {
	c := make(map[string]any, len(user)+16)
	for k, v := range user {
		c[k] = v
	}
	for _, k := range []string{"s3_endpoint", "s3_bucket", "s3_access_key", "s3_secret_key", "nats_url", "redis_url",
		"smtp_host", "pdf_service_url", "frontend_base_url", "backup_dir", "mcp_oauth_issuer"} {
		c[k] = ""
	}
	c["mcp_enabled"] = false
	c["cron_log_dir"] = filepath.Join(worktree, "cron-logs")
	c["db_name"] = dbName
	c["environment"] = "production"
	c["backend_port"] = port
	c["backend_host"] = "127.0.0.1"
	c["module_root"] = []string{filepath.Join(worktree, "core", "modules")}
	return c
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func tail(b []byte, n int) string {
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (r *release) Migrate(ctx context.Context, dbName string) error {
	port, err := freePort()
	if err != nil {
		return err
	}
	cfgFile := filepath.Join(r.worktree, "upgrade-config.json")
	raw, err := json.Marshal(releaseConfig(r.cfg, r.worktree, dbName, port))
	if err != nil {
		return err
	}
	if err := os.WriteFile(cfgFile, raw, 0o600); err != nil {
		return err
	}
	logFile := filepath.Join(r.worktree, "release.log")
	lf, err := os.Create(logFile)
	if err != nil {
		return err
	}
	defer lf.Close()
	cmd := exec.Command(r.bin, "-config", cfgFile) // not CommandContext: we stop it gracefully ourselves
	cmd.Dir = filepath.Join(r.worktree, "core")
	cmd.Stdout, cmd.Stderr = lf, lf
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	stop := func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			<-exited
		}
	}
	logTail := func() string { b, _ := os.ReadFile(logFile); return tail(bytes.TrimSpace(b), 50) }

	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/health"
	deadline := time.NewTimer(healthTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			stop()
			return ctx.Err()
		case err := <-exited:
			return fmt.Errorf("release %s exited before becoming healthy (%v):\n%s", r.tag, err, logTail())
		case <-deadline.C:
			stop()
			return fmt.Errorf("release %s not healthy after %s:\n%s", r.tag, healthTimeout, logTail())
		case <-tick.C:
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if resp, err := http.DefaultClient.Do(req); err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					stop()
					return nil
				}
			}
		}
	}
}
