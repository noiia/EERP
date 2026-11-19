package dbmanage

import (
	"archive/zip"
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v5"
)

const testKey = "a-master-key-for-tests"

// dbmCall runs one Handler method with the given master key, an optional
// :name, and a body (JSON, or multipart when contentType says so).
func dbmCall(t *testing.T, h echo.HandlerFunc, method, target, name, key, contentType string, body []byte) int {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	if key != "" {
		req.Header.Set("X-Master-Key", key)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if name != "" {
		c.SetPathValues(echo.PathValues{{Name: "name", Value: name}})
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec.Code
}

// restoreForm builds the restore upload: a name field and, unless file is
// nil, a file part holding file.
func restoreForm(t *testing.T, name string, file []byte) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("name", name)
	if file != nil {
		part, err := w.CreateFormFile("file", "backup.zip")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(file)
	}
	_ = w.Close()
	return w.FormDataContentType(), buf.Bytes()
}

func zipWith(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(content))
	}
	_ = zw.Close()
	return buf.Bytes()
}

// Every endpoint is gated by the master key alone (the group has no JWT): a
// missing or wrong key is a 401 before anything runs.
func TestHandler_RequiresTheMasterKey(t *testing.T) {
	h := NewHandler(&Manager{masterKey: testKey, prepared: map[string]*preparedTarget{}})
	for name, call := range map[string]echo.HandlerFunc{
		"list": h.List, "create": h.Create, "switch": h.Switch, "prepare": h.Prepare, "activate": h.Activate,
		"discard": h.DiscardPrepared, "delete": h.Delete, "extract": h.Extract, "restore": h.Restore,
	} {
		t.Run(name, func(t *testing.T) {
			for _, key := range []string{"", "wrong-key"} {
				if code := dbmCall(t, call, http.MethodPost, "/", "poc", key, "", []byte(`{}`)); code != http.StatusUnauthorized {
					t.Fatalf("key %q: status = %d, want 401", key, code)
				}
			}
		})
	}
}

// What each endpoint refuses before touching Postgres: malformed bodies, bad
// database names, a standby that isn't ready, S3 without an object store, and
// a restore upload that isn't a usable backup.
func TestHandler_RefusesBadRequests(t *testing.T) {
	h := NewHandler(&Manager{masterKey: testKey, prepared: map[string]*preparedTarget{}})
	notZip := []byte("this is not a zip")
	noDump := zipWith(t, map[string]string{"manifest.json": "[]"})

	cases := []struct {
		name        string
		call        echo.HandlerFunc
		target      string
		param       string
		contentType string
		body        []byte
		want        int
	}{
		{"create: malformed body", h.Create, "/", "", "", []byte(`{`), http.StatusBadRequest},
		{"create: bad name", h.Create, "/", "", "", []byte(`{"name":"Robert'); DROP"}`), http.StatusBadRequest},
		{"prepare: bad name", h.Prepare, "/", "Bad Name", "", nil, http.StatusBadRequest},
		{"activate: nothing prepared", h.Activate, "/", "standby", "", nil, http.StatusConflict},
		{"activate: bad name", h.Activate, "/", "Bad Name", "", nil, http.StatusInternalServerError},
		{"switch: bad name", h.Switch, "/", "Bad Name", "", nil, http.StatusInternalServerError},
		{"discard: nothing prepared", h.DiscardPrepared, "/", "standby", "", nil, http.StatusNoContent},
		{"extract: S3 without an object store", h.Extract, "/?include_s3=true", "poc", "", nil, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code := dbmCall(t, tc.call, http.MethodPost, tc.target, tc.param, testKey, tc.contentType, tc.body); code != tc.want {
				t.Fatalf("status = %d, want %d", code, tc.want)
			}
		})
	}

	restores := []struct {
		name string
		db   string
		file []byte
	}{
		{"restore: bad name", "Bad Name", noDump},
		{"restore: no file", "restored", nil},
		{"restore: not a zip", "restored", notZip},
		{"restore: no dump.dump entry", "restored", noDump},
	}
	for _, tc := range restores {
		t.Run(tc.name, func(t *testing.T) {
			ctype, body := restoreForm(t, tc.db, tc.file)
			if code := dbmCall(t, h.Restore, http.MethodPost, "/", "", testKey, ctype, body); code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", code)
			}
		})
	}
}
