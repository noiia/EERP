package main

import (
	"archive/zip"
	"context"
	"os"
	"testing"

	"core/internal/dbmanage"

	"github.com/jackc/pgx/v5"
)

// TestMakeFixture regenerates testdata/v0.108.0.zip: a real v0.108.0 database
// (migrated by that release, then seeded) as a version.json-less extract.
// EERP_MAKE_FIXTURE=1 CONFIG=… go test -run TestMakeFixture -timeout 20m
func TestMakeFixture(t *testing.T) {
	cfgPath := os.Getenv("CONFIG")
	if os.Getenv("EERP_MAKE_FIXTURE") != "1" || cfgPath == "" {
		t.Skip("set EERP_MAKE_FIXTURE=1 and CONFIG")
	}
	cfg := testConfig(t)
	ctx := context.Background()
	r, err := prepareRelease(ctx, cfgPath, "v0.108.0")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	conn := dbmanage.ConnFromConfig(cfg)
	name := tmpName("fixture")
	if err := dbmanage.CreateDatabase(ctx, conn, name); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dbmanage.DropDatabase(context.Background(), conn, name, cfg.DbName) }()
	if err := r.Migrate(ctx, name); err != nil {
		t.Fatal(err)
	}
	seed, err := os.ReadFile("testdata/seed-v0.108.0.sql")
	if err != nil {
		t.Fatal(err)
	}
	c, err := pgx.Connect(ctx, conn.DSN(name))
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Exec(ctx, string(seed))
	c.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Create("testdata/v0.108.0.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	w, err := zw.Create("dump.dump")
	if err != nil {
		t.Fatal(err)
	}
	if err := dbmanage.PgDump(ctx, conn, name, w); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}
