package notebook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stub ──────────────────────────────────────────────────────────────────────

type stubStore struct {
	listed    []NotebookPage
	listErr   error
	found     NotebookPage
	foundErr  error
	created   *NotebookPage
	createErr error
	updated   *NotebookPage
	updateErr error
	deletedID uuid.UUID
	deleteErr error

	gotTenant uuid.UUID
}

func (s *stubStore) Create(_ context.Context, p NotebookPage) (NotebookPage, error) {
	s.created = &p
	p.ID = uuid.New()
	return p, s.createErr
}

func (s *stubStore) Update(_ context.Context, p NotebookPage, _ uuid.UUID) (NotebookPage, error) {
	s.updated = &p
	return p, s.updateErr
}

func (s *stubStore) FindInTenant(_ context.Context, tenantID, _ uuid.UUID) (NotebookPage, error) {
	s.gotTenant = tenantID
	return s.found, s.foundErr
}

func (s *stubStore) ListByAnchor(_ context.Context, tenantID uuid.UUID, _ string, _ uuid.UUID) ([]NotebookPage, error) {
	s.gotTenant = tenantID
	return s.listed, s.listErr
}

func (s *stubStore) Delete(_ context.Context, tenantID, id uuid.UUID) error {
	s.gotTenant = tenantID
	s.deletedID = id
	return s.deleteErr
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func serve(t *testing.T, h echo.HandlerFunc, method, target string, body io.Reader, identity auth.Identity, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, body)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
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

// ── GET /notebook_pages ───────────────────────────────────────────────────────

func TestList(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()
	target := "/api/v1/notebook_pages?table=crm&record=" + recordID.String()

	t.Run("returns pages ordered by position, envelope shape", func(t *testing.T) {
		p1 := NotebookPage{TenantID: identity.TenantID, TableName: "crm", RecordID: recordID, Title: "First", Position: 0}
		p1.ID = uuid.New()
		p2 := NotebookPage{TenantID: identity.TenantID, TableName: "crm", RecordID: recordID, Title: "Second", Position: 1}
		p2.ID = uuid.New()
		store := &stubStore{listed: []NotebookPage{p1, p2}}

		rec := serve(t, newHandlerWith(store).List, http.MethodGet, target, nil, identity, nil)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		var got listEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.Total != 2 || len(got.Data) != 2 {
			t.Fatalf("envelope = %+v, want 2 entries", got)
		}
		if got.Data[0].Title != "First" || got.Data[1].Title != "Second" {
			t.Errorf("order = [%s, %s], want [First, Second]", got.Data[0].Title, got.Data[1].Title)
		}
		if store.gotTenant != identity.TenantID {
			t.Errorf("lookup tenant = %s, want caller's %s", store.gotTenant, identity.TenantID)
		}
	})

	t.Run("malformed anchor is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).List,
			http.MethodGet, "/api/v1/notebook_pages?table=Bad!&record="+recordID.String(), nil, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if code := errorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})

	t.Run("malformed record id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).List,
			http.MethodGet, "/api/v1/notebook_pages?table=crm&record=nope", nil, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

// ── POST /notebook_pages ──────────────────────────────────────────────────────

func TestCreate(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()

	t.Run("creates a page at the next position, tenant-pinned", func(t *testing.T) {
		existing := NotebookPage{Title: "Existing", Position: 0}
		existing.ID = uuid.New()
		store := &stubStore{listed: []NotebookPage{existing}}
		body := `{"table_name":"crm","record_id":"` + recordID.String() + `","title":"Meeting notes"}`

		rec := serve(t, newHandlerWith(store).Create,
			http.MethodPost, "/api/v1/notebook_pages", strings.NewReader(body), identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created == nil {
			t.Fatal("Create was not called")
		}
		if store.created.TenantID != identity.TenantID {
			t.Errorf("created tenant = %s, want caller's %s", store.created.TenantID, identity.TenantID)
		}
		if store.created.Position != 1 {
			t.Errorf("position = %d, want 1 (after the one existing page)", store.created.Position)
		}
		if store.created.Title != "Meeting notes" {
			t.Errorf("title = %q, want %q", store.created.Title, "Meeting notes")
		}
	})

	t.Run("validation failures", func(t *testing.T) {
		recID := recordID.String()
		tests := []struct {
			name string
			body string
		}{
			{"uppercase table name", `{"table_name":"Crm","record_id":"` + recID + `","title":"x"}`},
			{"malformed record id", `{"table_name":"crm","record_id":"nope","title":"x"}`},
			{"missing title", `{"table_name":"crm","record_id":"` + recID + `","title":""}`},
			{"title too long", `{"table_name":"crm","record_id":"` + recID + `","title":"` + strings.Repeat("x", 201) + `"}`},
			{"malformed body", `not json`},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				store := &stubStore{}
				rec := serve(t, newHandlerWith(store).Create,
					http.MethodPost, "/api/v1/notebook_pages", strings.NewReader(tt.body), identity, nil)
				if rec.Code != http.StatusBadRequest {
					t.Fatalf("status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
				}
				if code := errorCode(t, rec); code != "VALIDATION_ERROR" {
					t.Errorf("code = %s, want VALIDATION_ERROR", code)
				}
				if store.created != nil {
					t.Error("Create called despite validation failure")
				}
			})
		}
	})
}

// ── PUT /notebook_pages/:id ───────────────────────────────────────────────────

func TestUpdate(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("rewrites title and content, leaves the anchor/position alone", func(t *testing.T) {
		existing := NotebookPage{
			TenantID: identity.TenantID, TableName: "crm", RecordID: uuid.New(),
			Title: "Old title", Position: 2, Content: "old body",
		}
		existing.ID = uuid.New()
		store := &stubStore{found: existing}
		body := `{"title":"New title","content":"new body"}`

		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/notebook_pages/"+existing.ID.String(), strings.NewReader(body), identity,
			map[string]string{"id": existing.ID.String()})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.updated == nil {
			t.Fatal("Update was not called")
		}
		if store.updated.Title != "New title" || store.updated.Content != "new body" {
			t.Errorf("updated = %+v, want title/content overwritten", store.updated)
		}
		if store.updated.Position != 2 || store.updated.TableName != "crm" {
			t.Errorf("anchor/position changed: %+v", store.updated)
		}
	})

	t.Run("empty title is rejected", func(t *testing.T) {
		store := &stubStore{}
		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/notebook_pages/"+uuid.NewString(), strings.NewReader(`{"title":"","content":"x"}`),
			identity, map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if store.updated != nil {
			t.Error("Update called despite validation failure")
		}
	})

	t.Run("unknown id is 404 — covers cross-tenant denial (a foreign-tenant row filters out exactly like a missing one)", func(t *testing.T) {
		store := &stubStore{foundErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/notebook_pages/"+uuid.NewString(), strings.NewReader(`{"title":"x","content":"y"}`),
			identity, map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).Update,
			http.MethodPut, "/api/v1/notebook_pages/nope", strings.NewReader(`{"title":"x","content":"y"}`),
			identity, map[string]string{"id": "nope"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

// ── DELETE /notebook_pages/:id ────────────────────────────────────────────────

func TestDelete(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("removes the page, tenant-pinned", func(t *testing.T) {
		id := uuid.New()
		store := &stubStore{}
		rec := serve(t, newHandlerWith(store).Delete,
			http.MethodDelete, "/api/v1/notebook_pages/"+id.String(), nil, identity,
			map[string]string{"id": id.String()})

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.deletedID != id {
			t.Errorf("deleted id = %s, want %s", store.deletedID, id)
		}
		if store.gotTenant != identity.TenantID {
			t.Errorf("delete tenant = %s, want caller's %s", store.gotTenant, identity.TenantID)
		}
	})

	t.Run("unknown/cross-tenant id is 404", func(t *testing.T) {
		store := &stubStore{deleteErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store).Delete,
			http.MethodDelete, "/api/v1/notebook_pages/"+uuid.NewString(), nil, identity,
			map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).Delete,
			http.MethodDelete, "/api/v1/notebook_pages/nope", nil, identity,
			map[string]string{"id": "nope"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}
