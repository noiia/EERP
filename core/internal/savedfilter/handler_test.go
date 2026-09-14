package savedfilter

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
	listed    []SavedFilter
	listErr   error
	found     SavedFilter
	foundErr  error
	created   *SavedFilter
	createErr error
	updated   *SavedFilter
	updateErr error
	deletedID uuid.UUID
	deleteErr error

	gotTenant uuid.UUID
	gotUser   uuid.UUID
}

func (s *stubStore) Create(_ context.Context, sf SavedFilter) (SavedFilter, error) {
	s.created = &sf
	sf.ID = uuid.New()
	return sf, s.createErr
}

func (s *stubStore) Update(_ context.Context, sf SavedFilter, _ uuid.UUID) (SavedFilter, error) {
	s.updated = &sf
	return sf, s.updateErr
}

func (s *stubStore) FindInTenant(_ context.Context, tenantID, _ uuid.UUID) (SavedFilter, error) {
	s.gotTenant = tenantID
	return s.found, s.foundErr
}

func (s *stubStore) ListVisible(_ context.Context, tenantID, userID uuid.UUID, _ string) ([]SavedFilter, error) {
	s.gotTenant = tenantID
	s.gotUser = userID
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

// ── GET /saved_filters ────────────────────────────────────────────────────────

func TestList(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	target := "/api/v1/saved_filters?entity=crm"

	t.Run("returns visible filters, marking which the caller owns", func(t *testing.T) {
		mine := SavedFilter{TenantID: identity.TenantID, UserID: identity.UserID, Entity: "crm", Name: "Mine", Shared: false}
		mine.ID = uuid.New()
		other := SavedFilter{TenantID: identity.TenantID, UserID: uuid.New(), Entity: "crm", Name: "Team", Shared: true}
		other.ID = uuid.New()
		store := &stubStore{listed: []SavedFilter{mine, other}}

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
		if !got.Data[0].Mine {
			t.Errorf("own filter should report mine=true: %+v", got.Data[0])
		}
		if got.Data[1].Mine {
			t.Errorf("someone else's shared filter should report mine=false: %+v", got.Data[1])
		}
		if store.gotTenant != identity.TenantID || store.gotUser != identity.UserID {
			t.Errorf("lookup scope = tenant %s user %s, want caller's %s/%s",
				store.gotTenant, store.gotUser, identity.TenantID, identity.UserID)
		}
	})

	t.Run("malformed entity is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).List,
			http.MethodGet, "/api/v1/saved_filters?entity=Bad!", nil, identity, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if code := errorCode(t, rec); code != "VALIDATION_ERROR" {
			t.Errorf("code = %s, want VALIDATION_ERROR", code)
		}
	})
}

// ── POST /saved_filters ───────────────────────────────────────────────────────

func TestCreate(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("creates a filter owned by the caller, even when shared", func(t *testing.T) {
		store := &stubStore{}
		body := `{"entity":"crm","name":"Open deals","shared":true,"config":"{\"filters\":[]}"}`

		rec := serve(t, newHandlerWith(store).Create,
			http.MethodPost, "/api/v1/saved_filters", strings.NewReader(body), identity, nil)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.created == nil {
			t.Fatal("Create was not called")
		}
		if store.created.TenantID != identity.TenantID || store.created.UserID != identity.UserID {
			t.Errorf("created scope = %+v, want caller's tenant/user", store.created)
		}
		if !store.created.Shared || store.created.Name != "Open deals" {
			t.Errorf("created = %+v, want shared=true name=Open deals", store.created)
		}
	})

	t.Run("duplicate name in scope is 409", func(t *testing.T) {
		store := &stubStore{createErr: ErrDuplicateSavedFilterName}
		body := `{"entity":"crm","name":"Open deals","shared":false,"config":"{}"}`
		rec := serve(t, newHandlerWith(store).Create,
			http.MethodPost, "/api/v1/saved_filters", strings.NewReader(body), identity, nil)
		if rec.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("validation failures", func(t *testing.T) {
		tests := []struct {
			name string
			body string
		}{
			{"uppercase entity", `{"entity":"Crm","name":"x","config":"{}"}`},
			{"missing name", `{"entity":"crm","name":"","config":"{}"}`},
			{"name too long", `{"entity":"crm","name":"` + strings.Repeat("x", 201) + `","config":"{}"}`},
			{"malformed body", `not json`},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				store := &stubStore{}
				rec := serve(t, newHandlerWith(store).Create,
					http.MethodPost, "/api/v1/saved_filters", strings.NewReader(tt.body), identity, nil)
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

// ── PUT /saved_filters/:id ─────────────────────────────────────────────────────

func TestUpdate(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("owner can rename/reconfigure/reshare", func(t *testing.T) {
		existing := SavedFilter{TenantID: identity.TenantID, UserID: identity.UserID, Entity: "crm", Name: "Old", Shared: false}
		existing.ID = uuid.New()
		store := &stubStore{found: existing}
		body := `{"name":"New","shared":true,"config":"{\"filters\":[]}"}`

		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/saved_filters/"+existing.ID.String(), strings.NewReader(body), identity,
			map[string]string{"id": existing.ID.String()})

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.updated == nil {
			t.Fatal("Update was not called")
		}
		if store.updated.Name != "New" || !store.updated.Shared {
			t.Errorf("updated = %+v, want name=New shared=true", store.updated)
		}
	})

	t.Run("non-owner is 403, even on a shared filter", func(t *testing.T) {
		existing := SavedFilter{TenantID: identity.TenantID, UserID: uuid.New(), Entity: "crm", Name: "Team", Shared: true}
		existing.ID = uuid.New()
		store := &stubStore{found: existing}
		body := `{"name":"Hijacked","shared":true,"config":"{}"}`

		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/saved_filters/"+existing.ID.String(), strings.NewReader(body), identity,
			map[string]string{"id": existing.ID.String()})

		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.updated != nil {
			t.Error("Update called despite non-owner caller")
		}
	})

	t.Run("duplicate name in scope is 409", func(t *testing.T) {
		existing := SavedFilter{TenantID: identity.TenantID, UserID: identity.UserID, Entity: "crm", Name: "Old"}
		existing.ID = uuid.New()
		store := &stubStore{found: existing, updateErr: ErrDuplicateSavedFilterName}
		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/saved_filters/"+existing.ID.String(), strings.NewReader(`{"name":"Taken","shared":false,"config":"{}"}`),
			identity, map[string]string{"id": existing.ID.String()})
		if rec.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("empty name is rejected", func(t *testing.T) {
		store := &stubStore{}
		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/saved_filters/"+uuid.NewString(), strings.NewReader(`{"name":"","shared":false,"config":"{}"}`),
			identity, map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if store.updated != nil {
			t.Error("Update called despite validation failure")
		}
	})

	t.Run("unknown id is 404 — covers cross-tenant denial", func(t *testing.T) {
		store := &stubStore{foundErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store).Update,
			http.MethodPut, "/api/v1/saved_filters/"+uuid.NewString(), strings.NewReader(`{"name":"x","shared":false,"config":"{}"}`),
			identity, map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).Update,
			http.MethodPut, "/api/v1/saved_filters/nope", strings.NewReader(`{"name":"x","shared":false,"config":"{}"}`),
			identity, map[string]string{"id": "nope"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

// ── DELETE /saved_filters/:id ─────────────────────────────────────────────────

func TestDelete(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}

	t.Run("owner removes the filter, tenant-pinned", func(t *testing.T) {
		existing := SavedFilter{TenantID: identity.TenantID, UserID: identity.UserID, Entity: "crm", Name: "Mine"}
		existing.ID = uuid.New()
		store := &stubStore{found: existing}
		rec := serve(t, newHandlerWith(store).Delete,
			http.MethodDelete, "/api/v1/saved_filters/"+existing.ID.String(), nil, identity,
			map[string]string{"id": existing.ID.String()})

		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.deletedID != existing.ID {
			t.Errorf("deleted id = %s, want %s", store.deletedID, existing.ID)
		}
	})

	t.Run("non-owner is 403, even on a shared filter", func(t *testing.T) {
		existing := SavedFilter{TenantID: identity.TenantID, UserID: uuid.New(), Entity: "crm", Name: "Team", Shared: true}
		existing.ID = uuid.New()
		store := &stubStore{found: existing}
		rec := serve(t, newHandlerWith(store).Delete,
			http.MethodDelete, "/api/v1/saved_filters/"+existing.ID.String(), nil, identity,
			map[string]string{"id": existing.ID.String()})

		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403 (body: %s)", rec.Code, rec.Body.String())
		}
		if store.deletedID == existing.ID {
			t.Error("Delete called despite non-owner caller")
		}
	})

	t.Run("unknown/cross-tenant id is 404", func(t *testing.T) {
		store := &stubStore{foundErr: orm.ErrNotFound}
		rec := serve(t, newHandlerWith(store).Delete,
			http.MethodDelete, "/api/v1/saved_filters/"+uuid.NewString(), nil, identity,
			map[string]string{"id": uuid.NewString()})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("malformed id is 400", func(t *testing.T) {
		rec := serve(t, newHandlerWith(&stubStore{}).Delete,
			http.MethodDelete, "/api/v1/saved_filters/nope", nil, identity,
			map[string]string{"id": "nope"})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}
