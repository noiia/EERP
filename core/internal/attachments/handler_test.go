package attachments

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

type stubAttachments struct {
	anchor    Attachment
	anchorErr error
	found     Attachment
	foundErr  error

	created   *Attachment
	updated   *Attachment
	deletedID uuid.UUID

	createErr error
	updateErr error
	deleteErr error

	gotTenant uuid.UUID
}

func (s *stubAttachments) Create(_ context.Context, a Attachment) (Attachment, error) {
	s.created = &a
	a.ID = uuid.New()
	return a, s.createErr
}

func (s *stubAttachments) Update(_ context.Context, a Attachment, _ uuid.UUID) (Attachment, error) {
	s.updated = &a
	return a, s.updateErr
}

func (s *stubAttachments) FindInTenant(_ context.Context, tenantID, _ uuid.UUID) (Attachment, error) {
	s.gotTenant = tenantID
	return s.found, s.foundErr
}

func (s *stubAttachments) FindByAnchor(_ context.Context, tenantID uuid.UUID, _ string, _ uuid.UUID, _ string) (Attachment, error) {
	s.gotTenant = tenantID
	return s.anchor, s.anchorErr
}

func (s *stubAttachments) Delete(_ context.Context, _, id uuid.UUID) error {
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

// multipartUpload builds a POST /attachments body: the anchor form fields
// plus one `file` part carrying its own filename + Content-Type.
func multipartUpload(t *testing.T, fields map[string]string, filename, fileMime string, fileBytes []byte) (io.Reader, string) {
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
		header.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
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

// ── POST /attachments ────────────────────────────────────────────────────────

func TestUpload(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()
	anchor := map[string]string{
		"table_name": "property_management_equipment",
		"record_id":  recordID.String(),
		"field":      "billing_of_buy",
	}

	t.Run("creates metadata (with filename) and stores the object on a fresh anchor", func(t *testing.T) {
		store := &stubAttachments{anchorErr: orm.ErrNotFound}
		objects := &stubObjects{}
		body, contentType := multipartUpload(t, anchor, "invoice.pdf", "application/pdf", []byte("pdf-bytes"))

		rec := serve(t, newHandlerWith(store, objects).Upload,
			http.MethodPost, "/api/v1/attachments", contentType, body, identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created == nil {
			t.Fatal("Create was not called")
		}
		if store.created.Filename != "invoice.pdf" {
			t.Errorf("created filename = %q, want invoice.pdf", store.created.Filename)
		}
		if store.created.TenantID != identity.TenantID {
			t.Errorf("created tenant = %s, want caller's %s", store.created.TenantID, identity.TenantID)
		}
		wantPrefix := identity.TenantID.String() + "/property_management_equipment/" + recordID.String() + "/billing_of_buy/"
		if !strings.HasPrefix(objects.putKeys[0], wantPrefix) {
			t.Errorf("object key = %q, want prefix %q", objects.putKeys[0], wantPrefix)
		}
		if string(objects.putData) != "pdf-bytes" || objects.putMime != "application/pdf" {
			t.Errorf("stored (%q, %s), want (pdf-bytes, application/pdf)", objects.putData, objects.putMime)
		}
	})

	t.Run("accepts any mime type — no image whitelist, unlike pictures", func(t *testing.T) {
		store := &stubAttachments{anchorErr: orm.ErrNotFound}
		objects := &stubObjects{}
		body, contentType := multipartUpload(t, anchor, "notes.txt", "text/plain", []byte("hello"))

		rec := serve(t, newHandlerWith(store, objects).Upload,
			http.MethodPost, "/api/v1/attachments", contentType, body, identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("replaces the existing attachment on the same anchor, deletes the old object", func(t *testing.T) {
		existing := Attachment{
			TenantID: identity.TenantID, TableName: "property_management_equipment", RecordID: recordID,
			Field: "billing_of_buy", ObjectKey: "old/key", Filename: "old.pdf", Mime: "application/pdf", Size: 3,
		}
		existing.ID = uuid.New()
		store := &stubAttachments{anchor: existing}
		objects := &stubObjects{}
		body, contentType := multipartUpload(t, anchor, "new.pdf", "application/pdf", []byte("new-bytes"))

		rec := serve(t, newHandlerWith(store, objects).Upload,
			http.MethodPost, "/api/v1/attachments", contentType, body, identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created != nil {
			t.Error("Create called on the replace path")
		}
		if store.updated == nil || store.updated.ID != existing.ID {
			t.Fatal("Update was not called with the existing row's id")
		}
		if store.updated.Filename != "new.pdf" {
			t.Errorf("updated filename = %q, want new.pdf", store.updated.Filename)
		}
		if len(objects.deletedKeys) != 1 || objects.deletedKeys[0] != "old/key" {
			t.Errorf("deleted keys = %v, want [old/key]", objects.deletedKeys)
		}
	})

	t.Run("rejects a missing table_name/field", func(t *testing.T) {
		store := &stubAttachments{}
		body, contentType := multipartUpload(t, map[string]string{"record_id": recordID.String()}, "x.pdf", "application/pdf", []byte("x"))
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Upload,
			http.MethodPost, "/api/v1/attachments", contentType, body, identity, nil)
		if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "VALIDATION_ERROR" {
			t.Errorf("status/code = %d/%s, want 400/VALIDATION_ERROR", rec.Code, errorCode(t, rec))
		}
	})

	t.Run("rejects an upload with no file part", func(t *testing.T) {
		store := &stubAttachments{}
		body, contentType := multipartUpload(t, anchor, "", "", nil)
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Upload,
			http.MethodPost, "/api/v1/attachments", contentType, body, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
	})
}

// ── GET /attachments/:id ──────────────────────────────────────────────────────

func TestGet(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("streams the bytes with a download Content-Disposition carrying the original filename", func(t *testing.T) {
		found := Attachment{ObjectKey: "key1", Filename: "invoice 2026.pdf", Mime: "application/pdf"}
		found.ID = uuid.New()
		store := &stubAttachments{found: found}
		objects := &stubObjects{getBody: "pdf-bytes", getMime: "application/octet-stream"}

		rec := serve(t, newHandlerWith(store, objects).Get,
			http.MethodGet, "/api/v1/attachments/"+found.ID.String(), "", nil, identity,
			map[string]string{"id": found.ID.String()})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if rec.Body.String() != "pdf-bytes" {
			t.Errorf("body = %q, want pdf-bytes", rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/pdf" {
			t.Errorf("Content-Type = %q, want application/pdf (the stored mime wins over the object store's)", ct)
		}
		cd := rec.Header().Get("Content-Disposition")
		if !strings.Contains(cd, `attachment`) || !strings.Contains(cd, `invoice 2026.pdf`) {
			t.Errorf("Content-Disposition = %q, want an attachment disposition naming the original filename", cd)
		}
	})

	t.Run("404s on an unknown id", func(t *testing.T) {
		store := &stubAttachments{foundErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Get,
			http.MethodGet, "/api/v1/attachments/"+uuid.NewString(), "", nil, identity,
			map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})
}

// ── GET /attachments?table=&record=&field= ───────────────────────────────────

func TestFind(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("404s when the anchor has no attachment", func(t *testing.T) {
		store := &stubAttachments{anchorErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Find,
			http.MethodGet, "/api/v1/attachments?table=x&record="+uuid.NewString()+"&field=y", "", nil, identity, nil)
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("returns the metadata including filename on a hit", func(t *testing.T) {
		found := Attachment{TableName: "x", Field: "y", Filename: "doc.pdf", Mime: "application/pdf"}
		found.ID = uuid.New()
		store := &stubAttachments{anchor: found}
		rec := serve(t, newHandlerWith(store, &stubObjects{}).Find,
			http.MethodGet, "/api/v1/attachments?table=x&record="+uuid.NewString()+"&field=y", "", nil, identity, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		var resp attachmentResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp.Filename != "doc.pdf" {
			t.Errorf("filename = %q, want doc.pdf", resp.Filename)
		}
	})
}

// ── DELETE /attachments/:id ───────────────────────────────────────────────────

func TestDelete(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("removes the row then best-effort deletes the object", func(t *testing.T) {
		found := Attachment{ObjectKey: "key1"}
		found.ID = uuid.New()
		store := &stubAttachments{found: found}
		objects := &stubObjects{}

		rec := serve(t, newHandlerWith(store, objects).Delete,
			http.MethodDelete, "/api/v1/attachments/"+found.ID.String(), "", nil, identity,
			map[string]string{"id": found.ID.String()})

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.deletedID != found.ID {
			t.Errorf("deleted id = %s, want %s", store.deletedID, found.ID)
		}
		if len(objects.deletedKeys) != 1 || objects.deletedKeys[0] != "key1" {
			t.Errorf("deleted object keys = %v, want [key1]", objects.deletedKeys)
		}
	})

	t.Run("404s on an unknown id — nothing deleted", func(t *testing.T) {
		store := &stubAttachments{foundErr: orm.ErrNotFound}
		objects := &stubObjects{}
		rec := serve(t, newHandlerWith(store, objects).Delete,
			http.MethodDelete, "/api/v1/attachments/"+uuid.NewString(), "", nil, identity,
			map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
		if len(objects.deletedKeys) != 0 {
			t.Error("object deleted despite the row lookup failing")
		}
	})
}
