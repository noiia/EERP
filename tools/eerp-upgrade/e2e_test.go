package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"core/internal/dbmanage"
	"core/internal/version"

	"github.com/jackc/pgx/v5"
)

func TestUpgradeFrom_v0_108_0(t *testing.T) {
	cfg := testConfig(t)
	cfgPath := os.Getenv("CONFIG")
	ctx := context.Background()
	out := filepath.Join(t.TempDir(), "out.zip")
	rep, err := run(ctx, cfg, args{ConfigPath: cfgPath, In: "testdata/v0.108.0.zip", Out: out})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Diff.Failed() {
		t.Fatalf("diff: %s", rep)
	}
	in, err := openInput(out)
	if err != nil {
		t.Fatal(err)
	}
	defer in.zip.Close()
	if in.Version != strings.TrimPrefix(version.Version, "v") {
		t.Errorf("output version = %q, want %q", in.Version, version.Version)
	}
	dump := filepath.Join(t.TempDir(), "out.dump")
	if err := in.extractDump(dump); err != nil {
		t.Fatal(err)
	}
	conn := dbmanage.ConnFromConfig(cfg)
	name := tmpName("e2e")
	if err := dbmanage.CreateDatabase(ctx, conn, name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbmanage.DropDatabase(context.Background(), conn, name, cfg.DbName) })
	if err := dbmanage.PgRestore(ctx, conn, name, dump); err != nil {
		t.Fatal(err)
	}
	c, err := pgx.Connect(ctx, conn.DSN(name))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	for q, want := range map[string]int{
		// event.backfillContacts: the unlinked booking got a contact
		`SELECT count(*) FROM event_booking WHERE contact_id IS NOT NULL`: 1,
		// remaining_seats is new since v0.108.0 and generated from the seeded row
		`SELECT remaining_seats FROM event_session`:                  7,
		`SELECT count(*) FROM pg_tables WHERE tablename = 'project'`: 1,
		`SELECT count(*) FROM quote_line`:                            1,
	} {
		var got int
		if err := c.QueryRow(ctx, q).Scan(&got); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if got != want {
			t.Errorf("%s = %d, want %d", q, got, want)
		}
	}
}
