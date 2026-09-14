package pictures

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stubs ─────────────────────────────────────────────────────────────────────

type stubPictures struct {
	anchor    Picture
	anchorErr error
	found     Picture
	foundErr  error

	created   *Picture
	updated   *Picture
	deletedID uuid.UUID

	createErr error
	updateErr error
	deleteErr error

	gotTenant uuid.UUID
}

func (s *stubPictures) Create(_ context.Context, p Picture) (Picture, error) {
	s.created = &p
	p.ID = uuid.New()
	return p, s.createErr
}

func (s *stubPictures) Update(_ context.Context, p Picture, _ uuid.UUID) (Picture, error) {
	s.updated = &p
	return p, s.updateErr
}

func (s *stubPictures) FindInTenant(_ context.Context, tenantID, _ uuid.UUID) (Picture, error) {
	s.gotTenant = tenantID
	return s.found, s.foundErr
}

func (s *stubPictures) FindByAnchor(_ context.Context, tenantID uuid.UUID, _ string, _ uuid.UUID, _ string) (Picture, error) {
	s.gotTenant = tenantID
	return s.anchor, s.anchorErr
}

func (s *stubPictures) Delete(_ context.Context, _, id uuid.UUID) error {
	s.deletedID = id
	return s.deleteErr
}

type stubObjects struct {
	putKeys []string
	putMime string
	putData []byte
	putErr  error

	getBody string
	getMime string
	getErr  error

	deletedKeys []string
	deleteErr   error
}

func (s *stubObjects) Put(_ context.Context, key, contentType string, _ int64, body io.Reader) error {
	if s.putErr != nil {
		return s.putErr
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	s.putKeys = append(s.putKeys, key)
	s.putMime = contentType
	s.putData = data
	return nil
}

func (s *stubObjects) Get(_ context.Context, _ string) (io.ReadCloser, string, error) {
	if s.getErr != nil {
		return nil, "", s.getErr
	}
	return io.NopCloser(strings.NewReader(s.getBody)), s.getMime, nil
}

func (s *stubObjects) Delete(_ context.Context, key string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	s.deletedKeys = append(s.deletedKeys, key)
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// multipartUpload builds a POST /pictures body: the anchor form fields plus one
// `file` part carrying its own Content-Type (echo reads it from the part header).
func multipartUpload(t *testing.T, fields map[string]string, fileMime string, fileBytes []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	if fileBytes != nil {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="file"; filename="upload.png"`)
		header.Set("Content-Type", fileMime)
		part, err := w.CreatePart(header)
		if err != nil {
			t.Fatalf("create file part: %v", err)
		}
		if _, err := part.Write(fileBytes); err != nil {
			t.Fatalf("write file part: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &buf, w.FormDataContentType()
}

func serve(t *testing.T, h echo.HandlerFunc, method, target, contentType string, body io.Reader, identity auth.Identity, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req = req.WithContext(auth.SetIdentity(req.Context(), identity))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	for k, v := range params {
		c.SetParamNames(k)
		c.SetParamValues(v)
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error envelope: %v (body: %s)", err, rec.Body.String())
	}
	return payload.Error.Code
}

// ── POST /pictures ────────────────────────────────────────────────────────────

func TestUpload(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()
	anchor := map[string]string{
		"table_name": "contact",
		"record_id":  recordID.String(),
		"field":      "signature",
	}

	t.Run("creates metadata and stores the object on a fresh anchor", func(t *testing.T) {
		store := &stubPictures{anchorErr: orm.ErrNotFound}
		objects := &stubObjects{}
		body, contentType := multipartUpload(t, anchor, "image/png", []byte("png-bytes"))

		rec := serve(t, newHandlerWith(store, objects).Upload,
			http.MethodPost, "/api/v1/pictures", contentType, body, identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created == nil {
			t.Fatal("Create was not called")
		}
		if store.created.TenantID != identity.TenantID {
			t.Errorf("created tenant = %s, want caller's %s", store.created.TenantID, identity.TenantID)
		}
		if len(objects.putKeys) != 1 {
			t.Fatalf("Put calls = %d, want 1", len(objects.putKeys))
		}
		wantPrefix := identity.TenantID.String() + "/contact/" + recordID.String() + "/signature/"
		if !strings.HasPrefix(objects.putKeys[0], wantPrefix) {
			t.Errorf("object key = %q, want prefix %q", objects.putKeys[0], wantPrefix)
		}
		if store.created.ObjectKey != objects.putKeys[0] {
			t.Errorf("row object key %q != stored object %q", store.created.ObjectKey, objects.putKeys[0])
		}
		if string(objects.putData) != "png-bytes" || objects.putMime != "image/png" {
			t.Errorf("stored (%q, %s), want (png-bytes, image/png)", objects.putData, objects.putMime)
		}
	})

	t.Run("replaces the existing picture on the same anchor", func(t *testing.T) {
		existing := Picture{
			TenantID: identity.TenantID, TableName: "contact", RecordID: recordID,
			Field: "signature", ObjectKey: "old/key", Mime: "image/jpeg", Size: 3,
		}
		existing.ID = uuid.New()
		store := &stubPictures{anchor: existing}
		objects := &stubObjects{}
		body, contentType := multipartUpload(t, anchor, "image/webp", []byte("new-bytes"))

		rec := serve(t, newHandlerWith(store, objects).Upload,
			http.MethodPost, "/api/v1/pictures", contentType, body, identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created != nil {
			t.Error("Create called on the replace path")
		}
		if store.updated == nil {
			t.Fatal("Update was not called")
		}
		if store.updated.ID != existing.ID {
			t.Errorf("updated row id = %s, want the anchor's %s", store.updated.ID, existing.ID)
		}
		if store.updated.Mime != "image/webp" {
			t.Errorf("updated mime = %s, want image/webp", store.updated.Mime)
		}
		if len(objects.deletedKeys) != 1 || objects.deletedKeys[0] != "old/key" {
			t.Errorf("deleted objects = %v, want [old/key]", objects.deletedKeys)
		}
	})

	t.Run("validation failures", func(t *testing.T) {
		valid := func() map[string]string {
			m := map[string]string{}
			for k, v := range anchor {
				m[k] = v
			}
			return m
		}
		tests := []struct {
			name   string
			fields map[string]string
			mime   string
			file   []byte
		}{
			{name: "uppercase table name", fields: func() map[string]string { m := valid(); m["table_name"] = "Contact"; return m }(), mime: "image/png", file: []byte("x")},
			{name: "malformed record id", fields: func() map[string]string { m := valid(); m["record_id"] = "not-a-uuid"; return m }(), mime: "image/png", file: []byte("x")},
			{name: "missing file part", fields: valid(), mime: "", file: nil},
			{name: "disallowed mime", fields: valid(), mime: "image/gif", file: []byte("x")},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				store := &stubPictures{anchorErr: orm.ErrNotFound}
				objects := &stubObjects{}
				body, contentType := multipartUpload(t, tt.fields, tt.mime, tt.file)

				rec := serve(t, newHandlerWith(store, objects).Upload,
					http.MethodPost, "/api/v1/pictures", contentType, body, identity, nil)

				if rec.Code != http.StatusBadRequest {
					t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
				}
				if code := errorCode(t, rec); code != "VALIDATION_ERROR" {
					t.Errorf("code = %s, want VALIDATION_ERROR", code)
				}
				if len(objects.putKeys) != 0 {
					t.Error("object stored despite validation failure")
				}
			})
		}
	})
}

// ── GET /pictures/:id ─────────────────────────────────────────────────────────

func TestGet(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("streams the object with the row's mime", func(t *testing.T) {
		row := Picture{ObjectKey: "k", Mime: "image/png"}
		row.ID = uuid.New()
		store := &stubPictures{found: row}
		objects := &stubObjects{getBody: "the-bytes", getMime: "application/octet-stream"}

		rec := serve(t, newHandlerWith(store, objects).Get,
			http.MethodGet, "/api/v1/pictures/"+row.ID.String(), "", nil, identity,
			map[string]string{"id": row.ID.String()})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if got := rec.Body.String(); got != "the-bytes" {
			t.Errorf("body = %q, want the object bytes", got)
		}
		// The row's mime wins over whatever the object store reports.
		if ct := rec.Header().Get(echo.HeaderContentType); ct != "image/png" {
			t.Errorf("content type = %s, want image/png", ct)
		}
		if store.gotTenant != identity.TenantID {
			t.Errorf("lookup tenant = %s, want caller's %s", store.gotTenant, identity.TenantID)
		}
	})

	t.Run("unknown id is 404", func(t *testing.T) {
		store := &stubPictures{foundErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Get,
			http.MethodGet, "/api/v1/pictures/"+uuid.NewString(), "", nil, identity,
			map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubPictures{}, &stubObjects{}).Get,
			http.MethodGet, "/api/v1/pictures/nope", "", nil, identity,
			map[string]string{"id": "nope"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

// ── GET /pictures?table&record&field ─────────────────────────────────────────

func TestFind(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()
	target := "/api/v1/pictures?table=contact&record=" + recordID.String() + "&field=photo"

	t.Run("resolves the anchor to its metadata", func(t *testing.T) {
		row := Picture{
			TenantID: identity.TenantID, TableName: "contact", RecordID: recordID,
			Field: "photo", ObjectKey: "secret/key", Mime: "image/png", Size: 9,
		}
		row.ID = uuid.New()
		store := &stubPictures{anchor: row}

		rec := serve(t, newHandlerWith(store, &stubObjects{}).Find,
			http.MethodGet, target, "", nil, identity, nil)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		var got pictureResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if got.ID != row.ID || got.Mime != "image/png" || got.Size != 9 {
			t.Errorf("response = %+v, want the row's metadata", got)
		}
		// The object key locates tenant data in the bucket — it must never leave the server.
		if strings.Contains(rec.Body.String(), "secret/key") {
			t.Error("response leaks the object key")
		}
	})

	t.Run("anchor without a picture is 404", func(t *testing.T) {
		store := &stubPictures{anchorErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Find,
			http.MethodGet, target, "", nil, identity, nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed anchor is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubPictures{}, &stubObjects{}).Find,
			http.MethodGet, "/api/v1/pictures?table=Bad!&record="+recordID.String()+"&field=photo",
			"", nil, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

// ── DELETE /pictures/:id ──────────────────────────────────────────────────────

func TestDelete(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("removes the row then the object", func(t *testing.T) {
		row := Picture{ObjectKey: "k/1", Mime: "image/png"}
		row.ID = uuid.New()
		store := &stubPictures{found: row}
		objects := &stubObjects{}

		rec := serve(t, newHandlerWith(store, objects).Delete,
			http.MethodDelete, "/api/v1/pictures/"+row.ID.String(), "", nil, identity,
			map[string]string{"id": row.ID.String()})

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.deletedID != row.ID {
			t.Errorf("deleted row = %s, want %s", store.deletedID, row.ID)
		}
		if len(objects.deletedKeys) != 1 || objects.deletedKeys[0] != "k/1" {
			t.Errorf("deleted objects = %v, want [k/1]", objects.deletedKeys)
		}
	})

	t.Run("unknown id is 404", func(t *testing.T) {
		store := &stubPictures{foundErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Delete,
			http.MethodDelete, "/api/v1/pictures/"+uuid.NewString(), "", nil, identity,
			map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("row failure keeps the object", func(t *testing.T) {
		row := Picture{ObjectKey: "k/2"}
		row.ID = uuid.New()
		store := &stubPictures{found: row, deleteErr: context.DeadlineExceeded}
		objects := &stubObjects{}

		rec := serve(t, newHandlerWith(store, objects).Delete,
			http.MethodDelete, "/api/v1/pictures/"+row.ID.String(), "", nil, identity,
			map[string]string{"id": row.ID.String()})

		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if len(objects.deletedKeys) != 0 {
			t.Error("object deleted although the row removal failed")
		}
	})
}
