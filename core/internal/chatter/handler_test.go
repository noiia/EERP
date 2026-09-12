package chatter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stubs ────────────────────────────────────────────────────────────────────

type stubStore struct {
	listed    []ChatterMessage
	listErr   error
	created   *ChatterMessage
	createErr error

	gotTenant uuid.UUID
}

func (s *stubStore) Create(_ context.Context, m ChatterMessage) (ChatterMessage, error) {
	s.created = &m
	m.ID = uuid.New()
	return m, s.createErr
}

func (s *stubStore) ListByAnchor(_ context.Context, tenantID uuid.UUID, _ string, _ uuid.UUID) ([]ChatterMessage, error) {
	s.gotTenant = tenantID
	return s.listed, s.listErr
}

type stubUsers struct {
	found    auth.Users
	foundErr error
}

func (s *stubUsers) FindByID(_ context.Context, _ uuid.UUID) (auth.Users, error) {
	return s.found, s.foundErr
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

// ── GET /chatter_messages ──────────────────────────────────────────────────────

func TestList(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()
	target := "/api/v1/chatter_messages?table=crm&record=" + recordID.String()

	t.Run("returns messages, envelope shape, tenant-pinned lookup", func(t *testing.T) {
		m1 := ChatterMessage{TenantID: identity.TenantID, TableName: "crm", RecordID: recordID, AuthorEmail: "a@x.com", Kind: "message", Body: "First"}
		m1.ID = uuid.New()
		m2 := ChatterMessage{TenantID: identity.TenantID, TableName: "crm", RecordID: recordID, AuthorEmail: "b@x.com", Kind: "log", Body: "Second"}
		m2.ID = uuid.New()
		store := &stubStore{listed: []ChatterMessage{m1, m2}}

		rec := serve(t, newHandlerWith(store, &stubUsers{}).List, http.MethodGet, target, nil, identity, nil)

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
		if got.Data[0].Body != "First" || got.Data[1].Body != "Second" {
			t.Errorf("order = [%s, %s], want repository order preserved", got.Data[0].Body, got.Data[1].Body)
		}
		if store.gotTenant != identity.TenantID {
			t.Errorf("lookup tenant = %s, want caller's %s", store.gotTenant, identity.TenantID)
		}
	})

	t.Run("malformed anchor is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}, &stubUsers{}).List,
			http.MethodGet, "/api/v1/chatter_messages?table=Bad!&record="+recordID.String(), nil, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if code := errorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})

	t.Run("malformed record id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}, &stubUsers{}).List,
			http.MethodGet, "/api/v1/chatter_messages?table=crm&record=nope", nil, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

// ── POST /chatter_messages ─────────────────────────────────────────────────────

func TestCreate(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	recordID := uuid.New()
	users := &stubUsers{found: auth.Users{Email: "alice@example.com"}}

	t.Run("creates a message, author snapshotted from the caller's own identity", func(t *testing.T) {
		store := &stubStore{}
		body := `{"table_name":"crm","record_id":"` + recordID.String() + `","kind":"message","body":"Hello there"}`

		rec := serve(t, newHandlerWith(store, users).Create,
			http.MethodPost, "/api/v1/chatter_messages", strings.NewReader(body), identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created == nil {
			t.Fatal("Create was not called")
		}
		if store.created.TenantID != identity.TenantID {
			t.Errorf("created tenant = %s, want caller's %s", store.created.TenantID, identity.TenantID)
		}
		if store.created.AuthorID != identity.UserID {
			t.Errorf("author id = %s, want caller's %s", store.created.AuthorID, identity.UserID)
		}
		if store.created.AuthorEmail != "alice@example.com" {
			t.Errorf("author email = %q, want the resolved caller's email", store.created.AuthorEmail)
		}
		if store.created.Kind != "message" || store.created.Body != "Hello there" {
			t.Errorf("created = %+v, want kind=message body=%q", store.created, "Hello there")
		}
	})

	t.Run("accepts kind=log the same way (the form's own edit summary)", func(t *testing.T) {
		store := &stubStore{}
		body := `{"table_name":"crm","record_id":"` + recordID.String() + `","kind":"log","body":"Changed status: open -> won"}`

		rec := serve(t, newHandlerWith(store, users).Create,
			http.MethodPost, "/api/v1/chatter_messages", strings.NewReader(body), identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created.Kind != "log" {
			t.Errorf("kind = %q, want log", store.created.Kind)
		}
	})

	t.Run("validation failures", func(t *testing.T) {
		recID := recordID.String()
		tests := []struct {
			name string
			body string
		}{
			{"uppercase table name", `{"table_name":"Crm","record_id":"` + recID + `","kind":"message","body":"x"}`},
			{"malformed record id", `{"table_name":"crm","record_id":"nope","kind":"message","body":"x"}`},
			{"unknown kind", `{"table_name":"crm","record_id":"` + recID + `","kind":"system","body":"x"}`},
			{"empty body", `{"table_name":"crm","record_id":"` + recID + `","kind":"message","body":"   "}`},
			{"body too long", `{"table_name":"crm","record_id":"` + recID + `","kind":"message","body":"` + strings.Repeat("x", maxBodyLen+1) + `"}`},
			{"malformed body", `not json`},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				store := &stubStore{}
				rec := serve(t, newHandlerWith(store, users).Create,
					http.MethodPost, "/api/v1/chatter_messages", strings.NewReader(tt.body), identity, nil)
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
