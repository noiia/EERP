package dbmanage

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"core/internal/testdb"
	_ "core/modules/attachments"
	_ "core/modules/pictures"

	"github.com/google/uuid"
)

// persistDBName rewrites only db_name, keeps every other key, and refuses
// (without touching the file) anything it can't read or parse.
func TestPersistDBName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "eerp-config.json")
	if err := os.WriteFile(path, []byte(`{"db_name": "old", "db_host": "db", "module_root": ["a"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := persistDBName(path, "new"); err != nil {
		t.Fatalf("persist: %v", err)
	}
	var doc map[string]any
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["db_name"] != "new" || doc["db_host"] != "db" || doc["module_root"] == nil {
		t.Errorf("config after persist = %s", raw)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("the temp file was left behind")
	}

	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte("{not json"), 0o644)
	for name, p := range map[string]string{
		"no path":      "",
		"missing file": filepath.Join(dir, "absent.json"),
		"not JSON":     bad,
	} {
		if err := persistDBName(p, "x"); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	// A directory that can't take the temp file.
	if err := persistDBName(filepath.Join(dir, "missing-dir", "c.json"), "x"); err == nil {
		t.Error("unwritable location: want an error")
	}
}

// BuildManifest lists every picture and attachment object of one database,
// and is never nil — an empty database encodes as [].
func TestBuildManifest(t *testing.T) {
	ctx := context.Background()
	cfg := testdb.Config(t)
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "pictures", "attachments")
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DELETE FROM picture WHERE tenant_id = $1`, tenant)
		_, _ = app.DB.Exec(ctx, `DELETE FROM attachment WHERE tenant_id = $1`, tenant)
	})
	if _, err := app.DB.Exec(ctx, `INSERT INTO picture (tenant_id, table_name, record_id, field, object_key, mime, size)
		VALUES ($1, 'product', $2, 'picture', 'k/pic', 'image/png', 3)`, tenant, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO attachment (tenant_id, table_name, record_id, field, object_key, mime, size, filename)
		VALUES ($1, 'invoice', $2, 'file', 'k/doc', 'application/pdf', 3, 'a.pdf')`, tenant, uuid.New()); err != nil {
		t.Fatal(err)
	}

	conn := connInfo{Host: cfg.DbHost, Port: cfg.DbPort, User: cfg.DbUser, Password: cfg.DbPassword}
	entries, err := BuildManifest(ctx, conn, cfg.DbName)
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	found := map[string]string{}
	for _, e := range entries {
		if e.TenantID == tenant.String() {
			found[e.Table] = e.ObjectKey
		}
	}
	if found["picture"] != "k/pic" || found["attachment"] != "k/doc" {
		t.Errorf("manifest entries for the tenant = %v", found)
	}
	if _, err := BuildManifest(ctx, conn, "no_such_database_"+strings.ReplaceAll(uuid.NewString()[:8], "-", "")); err == nil {
		t.Error("an unknown database: want an error")
	}
}

// saveUpload and extractZipEntry copy a multipart upload / one zip entry to
// disk byte for byte, and fail on a missing entry or an unwritable target.
func TestUploadAndZipHelpers(t *testing.T) {
	dir := t.TempDir()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "dump.zip")
	_, _ = fw.Write([]byte("zip bytes"))
	_ = mw.Close()
	req := httptest.NewRequest("POST", "/", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if err := req.ParseMultipartForm(1 << 20); err != nil {
		t.Fatal(err)
	}
	fh := req.MultipartForm.File["file"][0]
	dst := filepath.Join(dir, "upload.zip")
	if err := saveUpload(fh, dst); err != nil {
		t.Fatalf("saveUpload: %v", err)
	}
	if got, _ := os.ReadFile(dst); string(got) != "zip bytes" {
		t.Errorf("saved upload = %q", got)
	}
	if err := saveUpload(fh, filepath.Join(dir, "missing", "x")); err == nil {
		t.Error("saveUpload to a missing directory: want an error")
	}

	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	w, _ := zw.Create("dump.sql")
	_, _ = w.Write([]byte("SELECT 1;"))
	_ = zw.Close()
	zr, err := zip.NewReader(bytes.NewReader(zbuf.Bytes()), int64(zbuf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "dump.sql")
	if err := extractZipEntry(zr, "dump.sql", out); err != nil {
		t.Fatalf("extractZipEntry: %v", err)
	}
	if got, _ := os.ReadFile(out); string(got) != "SELECT 1;" {
		t.Errorf("extracted = %q", got)
	}
	if err := extractZipEntry(zr, "absent.sql", filepath.Join(dir, "a")); err == nil {
		t.Error("a missing entry: want an error")
	}
	if err := extractZipEntry(zr, "dump.sql", filepath.Join(dir, "missing", "x")); err == nil {
		t.Error("an unwritable target: want an error")
	}
}
