package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"core/internal/dbmanage"
	"core/internal/version"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type stubMigrator struct {
	ver string
	fn  func(ctx context.Context, cfg stubEnv, db string) error
	cfg stubEnv
}
type stubEnv struct{}

func (s stubMigrator) Version() string { return s.ver }
func (s stubMigrator) Migrate(ctx context.Context, db string) error {
	return s.fn(ctx, s.cfg, db)
}

func buildInput(t *testing.T, dir string) (in string, name string) {
	t.Helper()
	cfg := testConfig(t)
	src := freshDB(t, cfg)
	id := uuid.NewString()
	snapshot(t, cfg, src, "INSERT INTO contact (id, tenant_id, name, kind, created_at, updated_at) VALUES ('"+id+"', '"+uuid.NewString()+"', 'Upg Test', 'contact', now(), now())")
	var dump bytes.Buffer
	if err := dbmanage.PgDump(context.Background(), dbmanage.ConnFromConfig(cfg), src, &dump); err != nil {
		t.Fatal(err)
	}
	in = filepath.Join(dir, "in.zip")
	f, _ := os.Create(in)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("dump.dump")
	_, _ = w.Write(dump.Bytes())
	w, _ = zw.Create("manifest.json")
	_, _ = w.Write([]byte(`{}`))
	w, _ = zw.Create("s3/k")
	_, _ = w.Write([]byte("object-bytes"))
	_ = zw.Close()
	_ = f.Close()
	return in, id
}

func upgradeDBCount(t *testing.T) int {
	t.Helper()
	cfg := testConfig(t)
	ctx := context.Background()
	c, err := pgx.Connect(ctx, dbmanage.ConnFromConfig(cfg).DSN("postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	var n int
	if err := c.QueryRow(ctx, `SELECT count(*) FROM pg_database WHERE datname LIKE 'eerp\_upgrade\_tmp\_%' OR datname LIKE 'eerp\_upgrade\_ref\_%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func realMigrator(t *testing.T) migrator {
	return inProcess{cfg: testConfig(t)}
}

func TestRun_RoundTrip(t *testing.T) {
	cfg := testConfig(t)
	dir := t.TempDir()
	in, id := buildInput(t, dir)
	out := filepath.Join(dir, "out.zip")
	rep, err := runWith(context.Background(), cfg, args{In: in, Out: out}, realMigrator(t))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Diff.Failed() || rep.S3Objects != 1 {
		t.Fatalf("report: %+v", rep)
	}
	z := readZip(t, out)
	if z["s3/k"] != "object-bytes" || !strings.Contains(z["version.json"], version.Version) {
		t.Errorf("zip entries: %v", z["version.json"])
	}
	// restore the output and find the contact
	dumpPath := filepath.Join(dir, "d.dump")
	_ = os.WriteFile(dumpPath, []byte(z["dump.dump"]), 0o600)
	conn := dbmanage.ConnFromConfig(cfg)
	name := "eerp_upgrade_t_chk" + id[:6]
	if err := dbmanage.CreateDatabase(context.Background(), conn, name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbmanage.DropDatabase(context.Background(), conn, name, cfg.DbName) })
	if err := dbmanage.PgRestore(context.Background(), conn, name, dumpPath); err != nil {
		t.Fatal(err)
	}
	c, err := pgx.Connect(context.Background(), conn.DSN(name))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	var n string
	if err := c.QueryRow(context.Background(), `SELECT name FROM contact WHERE id = $1`, id).Scan(&n); err != nil || n != "Upg Test" {
		t.Fatalf("contact: %q %v", n, err)
	}
	if upgradeDBCount(t) != 0 {
		t.Error("temp databases left behind")
	}
}

func TestRun_RefusesNewerInput(t *testing.T) {
	cfg := testConfig(t)
	dir := t.TempDir()
	in := filepath.Join(dir, "in.zip")
	makeZip(t, in, map[string]string{"dump.dump": "x", "version.json": `{"version":"dev"}`})
	out := filepath.Join(dir, "out.zip")
	before := upgradeDBCount(t)
	_, err := runWith(context.Background(), cfg, args{In: in, Out: out}, stubMigrator{ver: "0.170.0"})
	if err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("err = %v", err)
	}
	if _, e := os.Stat(out); e == nil {
		t.Error("output written")
	}
	if upgradeDBCount(t) != before {
		t.Error("database created")
	}
}

func TestRun_FailureCleansUp(t *testing.T) {
	cfg := testConfig(t)
	dir := t.TempDir()
	in, _ := buildInput(t, dir)
	out := filepath.Join(dir, "out.zip")
	m := stubMigrator{ver: version.Version, fn: func(context.Context, stubEnv, string) error { return errors.New("boom") }}
	if _, err := runWith(context.Background(), cfg, args{In: in, Out: out}, m); err == nil {
		t.Fatal("want error")
	}
	for _, p := range []string{out, out + ".partial"} {
		if _, e := os.Stat(p); e == nil {
			t.Errorf("%s exists", p)
		}
	}
	if upgradeDBCount(t) != 0 {
		t.Error("temp databases left behind")
	}
}

func TestRun_DriftFails(t *testing.T) {
	cfg := testConfig(t)
	dir := t.TempDir()
	in, _ := buildInput(t, dir)
	out := filepath.Join(dir, "out.zip")
	m := stubMigrator{ver: version.Version, fn: func(ctx context.Context, _ stubEnv, db string) error {
		if err := provision(ctx, cfg, db); err != nil {
			return err
		}
		if strings.HasPrefix(db, "eerp_upgrade_tmp_") {
			snapshot(t, cfg, db, "ALTER TABLE contact DROP COLUMN phone")
		}
		return nil
	}}
	_, err := runWith(context.Background(), cfg, args{In: in, Out: out}, m)
	if err == nil || !strings.Contains(err.Error(), "column:contact.phone") {
		t.Fatalf("err = %v", err)
	}
	if _, e := os.Stat(out); e == nil {
		t.Error("output written")
	}
	if upgradeDBCount(t) != 0 {
		t.Error("temp databases left behind")
	}
}
