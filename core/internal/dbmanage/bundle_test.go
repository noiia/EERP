package dbmanage

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"core/internal/testdb"
	"core/internal/version"

	"github.com/google/uuid"
)

type memStore map[string]string

func (m memStore) Put(context.Context, string, string, int64, io.Reader) error { return nil }
func (m memStore) Delete(context.Context, string) error                        { return nil }
func (m memStore) Get(_ context.Context, key string) (io.ReadCloser, string, error) {
	v, ok := m[key]
	if !ok {
		return nil, "", errors.New("no such key")
	}
	return io.NopCloser(strings.NewReader(v)), "image/png", nil
}

// stubDump replaces pg_dump (absent on dev hosts) for the test's duration.
func stubDump(t *testing.T) {
	t.Helper()
	prev := dumpDB
	dumpDB = func(_ context.Context, _ Conn, db string, w io.Writer) error {
		_, err := io.WriteString(w, "DUMP:"+db)
		return err
	}
	t.Cleanup(func() { dumpDB = prev })
}

func readZip(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		v, _ := io.ReadAll(rc)
		_ = rc.Close()
		out[f.Name] = string(v)
	}
	return out
}

func TestWriteBundle_RecordsVersion(t *testing.T) {
	stubDump(t)
	prev := version.Version
	version.Version = "0.170.0"
	t.Cleanup(func() { version.Version = prev })

	var buf bytes.Buffer
	if _, err := (&Manager{}).WriteBundle(context.Background(), &buf, "x", false); err != nil {
		t.Fatal(err)
	}
	got := readZip(t, buf.Bytes())
	var vf VersionFile
	if err := json.Unmarshal([]byte(got[VersionEntry]), &vf); err != nil || vf.Version != "0.170.0" {
		t.Fatalf("version.json = %q (%v)", got[VersionEntry], err)
	}
	if got["dump.dump"] != "DUMP:x" {
		t.Fatalf("dump.dump = %q", got["dump.dump"])
	}
}

func TestWriteBundle(t *testing.T) {
	stubDump(t)
	ctx := context.Background()

	t.Run("S3 requested without a store", func(t *testing.T) {
		m := &Manager{}
		if _, err := m.WriteBundle(ctx, io.Discard, "poc", true); !errors.Is(err, ErrNoObjectStore) {
			t.Fatalf("err = %v, want ErrNoObjectStore", err)
		}
	})

	t.Run("dump only", func(t *testing.T) {
		var buf bytes.Buffer
		n, err := (&Manager{}).WriteBundle(ctx, &buf, "poc", false)
		if err != nil || n != 0 {
			t.Fatalf("n=%d err=%v", n, err)
		}
		files := readZip(t, buf.Bytes())
		if files["dump.dump"] != "DUMP:poc" || len(files) != 2 {
			t.Errorf("zip = %v", files)
		}
	})

	t.Run("with S3 objects", func(t *testing.T) {
		cfg := testdb.Config(t)
		app := testdb.Open(t)
		testdb.MigrateModules(t, app, "pictures", "attachments", "auth", "teams")
		tenant := uuid.New()
		key := "k/" + tenant.String()
		t.Cleanup(func() { _, _ = app.DB.Exec(ctx, `DELETE FROM picture WHERE tenant_id = $1`, tenant) })
		if _, err := app.DB.Exec(ctx, `INSERT INTO picture (tenant_id, table_name, record_id, field, object_key, mime, size)
			VALUES ($1, 'product', $2, 'picture', $3, 'image/png', 3)`, tenant, uuid.New(), key); err != nil {
			t.Fatal(err)
		}
		store := memStore{}
		entries, err := BuildManifest(ctx, Conn{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}, cfg.DbName)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			store[e.ObjectKey] = "bytes:" + e.ObjectKey
		}
		m := &Manager{objects: store, conn: Conn{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}}
		var buf bytes.Buffer
		n, err := m.WriteBundle(ctx, &buf, cfg.DbName, true)
		if err != nil {
			t.Fatal(err)
		}
		files := readZip(t, buf.Bytes())
		if n != len(store) || files["s3/"+key] != "bytes:"+key || files["manifest.json"] == "" {
			t.Errorf("objects=%d (store %d), s3 entry=%q", n, len(store), files["s3/"+key])
		}
	})
}

func TestDatabaseNamesAndMaintenanceConn(t *testing.T) {
	ctx := context.Background()
	cfg := testdb.Config(t)
	m := &Manager{conn: Conn{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}}
	names, err := m.DatabaseNames(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, n := range names {
		found = found || n == cfg.DbName
	}
	if !found {
		t.Errorf("names %v miss the test database %s", names, cfg.DbName)
	}
	conn, err := m.MaintenanceConn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var db string
	if err := conn.QueryRow(ctx, `SELECT current_database()`).Scan(&db); err != nil || db != "postgres" {
		t.Errorf("maintenance db = %q, err %v", db, err)
	}
}
