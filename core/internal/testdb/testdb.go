// Package testdb gives integration tests the dev database, one way for every
// package: TEST_DSN wins (CI), else the DSN is derived from the eerp config
// file named by CONFIG (what `make run-back-tests` sets; `make bootstrap`
// fills its secrets). With neither set the test is skipped, so a plain `go test ./...` stays DB-free.
package testdb

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"core/internal/common"
	"core/internal/module"
	"core/internal/types"
	"core/orm"
)

// Config returns the app config for tests: the eerp-config.json named by
// CONFIG (else found by walking up from the working directory) with paths
// resolved — then, if TEST_DSN is
// set, its database coordinates in place of the file's. With neither TEST_DSN
// nor CONFIG set, t is skipped.
func Config(t testing.TB) *types.Config {
	t.Helper()
	dsn, path := os.Getenv("TEST_DSN"), os.Getenv("CONFIG")
	if dsn == "" && path == "" {
		t.Skip("neither TEST_DSN nor CONFIG set — skipping integration test")
	}
	if path == "" {
		path = findConfig(t)
	}
	cfg, err := common.DecodeJSON[*types.Config](path)
	if err != nil {
		t.Fatalf("testdb: read %s: %v", path, err)
	}
	cfg.ResolvePaths(filepath.Dir(path))
	if dsn != "" {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatalf("testdb: parse TEST_DSN: %v", err)
		}
		cfg.DbUser = u.User.Username()
		cfg.DbPassword, _ = u.User.Password()
		cfg.DbHost = u.Hostname()
		cfg.DbName = strings.TrimPrefix(u.Path, "/")
		if cfg.DbPort, err = strconv.Atoi(u.Port()); err != nil {
			cfg.DbPort = 5432
		}
	}
	return cfg
}

// findConfig walks up from the working directory to the repo's eerp-config.json.
func findConfig(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("testdb: getwd: %v", err)
	}
	for {
		p := filepath.Join(dir, "eerp-config.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("testdb: eerp-config.json not found above the working directory")
		}
		dir = parent
	}
}

// DSN returns the test database DSN, or skips t.
func DSN(t testing.TB) string {
	t.Helper()
	if dsn := os.Getenv("TEST_DSN"); dsn != "" {
		return dsn
	}
	return Config(t).DSN()
}

// Open returns an orm.App on the test database, closed when t ends.
func Open(t testing.TB) *orm.App {
	t.Helper()
	app, err := orm.New(orm.Config{DSN: DSN(t)}, nil)
	if err != nil {
		t.Fatalf("testdb: open: %v", err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app
}

// Migrate ensures each registered table exists with its current columns, so a
// test works on a fresh database (CI) as well as on a migrated dev one.
// Tables must be registered first (a module's Register(), or orm.Register).
func Migrate(t testing.TB, app *orm.App, tables ...string) {
	t.Helper()
	if err := module.EnsureSchema(context.Background(), app.DB, tables...); err != nil {
		t.Fatalf("testdb: migrate: %v", err)
	}
}

// MigrateModules gives the test database the named Go modules' real schema
// (see module.MigrateModules). The test must import each module's package
// (a blank import is enough) so it is registered.
func MigrateModules(t testing.TB, app *orm.App, names ...string) {
	t.Helper()
	if err := module.MigrateModules(context.Background(), app.DB, names...); err != nil {
		t.Fatalf("testdb: migrate modules: %v", err)
	}
}
