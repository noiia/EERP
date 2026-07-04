package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// ── Stubs ─────────────────────────────────────────────────────────────────────

type stubAdminUsers struct {
	users     []Users
	user      Users
	err       error
	gotTenant uuid.UUID
	gotID     uuid.UUID
	gotEmail  string
}

func (s *stubAdminUsers) ListByTenant(_ context.Context, tenantID uuid.UUID) ([]Users, error) {
	s.gotTenant = tenantID
	return s.users, s.err
}

func (s *stubAdminUsers) FindInTenant(_ context.Context, tenantID, id uuid.UUID) (Users, error) {
	s.gotTenant, s.gotID = tenantID, id
	return s.user, s.err
}

func (s *stubAdminUsers) UpdateEmail(_ context.Context, tenantID, id uuid.UUID, email string) (Users, error) {
	s.gotTenant, s.gotID, s.gotEmail = tenantID, id, email
	if s.err != nil {
		return Users{}, s.err
	}
	u := s.user
	u.Email = email
	return u, nil
}

type stubAdminRoles struct {
	roles   []Roles
	role    Roles
	err     error
	gotName string
	gotDesc string
}

func (s *stubAdminRoles) ListByTenant(_ context.Context, _ uuid.UUID) ([]Roles, error) {
	return s.roles, s.err
}

func (s *stubAdminRoles) FindInTenant(_ context.Context, _, _ uuid.UUID) (Roles, error) {
	return s.role, s.err
}

func (s *stubAdminRoles) UpdateRole(_ context.Context, _, _ uuid.UUID, name, description string) (Roles, error) {
	s.gotName, s.gotDesc = name, description
	if s.err != nil {
		return Roles{}, s.err
	}
	r := s.role
	r.Name, r.Description = name, description
	return r, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func serveAdmin(t *testing.T, h echo.HandlerFunc, method, target, paramID, body string, identity Identity) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(SetIdentity(req.Context(), identity))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if paramID != "" {
		c.SetParamNames("id")
		c.SetParamValues(paramID)
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

// ── Users ─────────────────────────────────────────────────────────────────────

func TestAdminListUsers(t *testing.T) {
	identity := Identity{UserID: uuid.New(), TenantID: uuid.New()}
	users := &stubAdminUsers{users: []Users{
		{TenantID: identity.TenantID, Email: "a@x.io", PasswordHash: "secret-hash"},
	}}
	h := newAdminHandlerWith(users, &stubAdminRoles{})

	rec := serveAdmin(t, h.ListUsers, http.MethodGet, "/users", "", "", identity)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if users.gotTenant != identity.TenantID {
		t.Errorf("tenant = %s, want the caller's %s", users.gotTenant, identity.TenantID)
	}
	body := rec.Body.String()
	if strings.Contains(body, "secret-hash") || strings.Contains(body, "password") {
		t.Fatalf("password hash leaked into the response: %s", body)
	}
	if strings.Contains(body, "tenant_id") {
		t.Fatalf("tenant_id leaked into the response: %s", body)
	}

	var resp struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Total != 1 || len(resp.Data) != 1 {
		t.Fatalf("total = %d, data len = %d, want 1/1", resp.Total, len(resp.Data))
	}
	if resp.Data[0]["email"] != "a@x.io" {
		t.Errorf("email = %v, want a@x.io", resp.Data[0]["email"])
	}
}

func TestAdminGetUser(t *testing.T) {
	identity := Identity{UserID: uuid.New(), TenantID: uuid.New()}
	id := uuid.New()

	tests := []struct {
		name       string
		paramID    string
		stub       *stubAdminUsers
		wantStatus int
	}{
		{name: "found", paramID: id.String(), stub: &stubAdminUsers{user: Users{Email: "a@x.io"}}, wantStatus: http.StatusOK},
		{name: "invalid id", paramID: "not-a-uuid", stub: &stubAdminUsers{}, wantStatus: http.StatusBadRequest},
		{name: "missing or wrong tenant", paramID: id.String(), stub: &stubAdminUsers{err: orm.ErrNotFound}, wantStatus: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newAdminHandlerWith(tt.stub, &stubAdminRoles{})
			rec := serveAdmin(t, h.GetUser, http.MethodGet, "/users/"+tt.paramID, tt.paramID, "", identity)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}
}

func TestAdminUpdateUser(t *testing.T) {
	identity := Identity{UserID: uuid.New(), TenantID: uuid.New()}
	id := uuid.New()

	tests := []struct {
		name       string
		body       string
		stubErr    error
		wantStatus int
		wantEmail  string
	}{
		{name: "valid email", body: `{"email":"new@x.io"}`, wantStatus: http.StatusOK, wantEmail: "new@x.io"},
		{name: "surrounding space trimmed", body: `{"email":"  new@x.io  "}`, wantStatus: http.StatusOK, wantEmail: "new@x.io"},
		{name: "extra fields ignored, email still whitelisted", body: `{"email":"new@x.io","password_hash":"evil","tenant_id":"11111111-1111-1111-1111-111111111111"}`, wantStatus: http.StatusOK, wantEmail: "new@x.io"},
		{name: "missing @", body: `{"email":"nope"}`, wantStatus: http.StatusBadRequest},
		{name: "leading @ only", body: `{"email":"@x.io"}`, wantStatus: http.StatusBadRequest},
		{name: "empty", body: `{"email":""}`, wantStatus: http.StatusBadRequest},
		{name: "not found", body: `{"email":"new@x.io"}`, stubErr: orm.ErrNotFound, wantStatus: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			users := &stubAdminUsers{user: Users{Email: "old@x.io"}, err: tt.stubErr}
			h := newAdminHandlerWith(users, &stubAdminRoles{})
			rec := serveAdmin(t, h.UpdateUser, http.MethodPut, "/users/"+id.String(), id.String(), tt.body, identity)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusOK {
				return
			}
			if users.gotEmail != tt.wantEmail {
				t.Errorf("saved email = %q, want %q", users.gotEmail, tt.wantEmail)
			}
			if users.gotTenant != identity.TenantID || users.gotID != id {
				t.Errorf("update scoped to (%s,%s), want (%s,%s)", users.gotTenant, users.gotID, identity.TenantID, id)
			}
		})
	}
}

// ── Roles ─────────────────────────────────────────────────────────────────────

func TestAdminListRoles(t *testing.T) {
	identity := Identity{UserID: uuid.New(), TenantID: uuid.New()}
	h := newAdminHandlerWith(&stubAdminUsers{}, &stubAdminRoles{roles: []Roles{{Name: "admin", Description: "all"}}})

	rec := serveAdmin(t, h.ListRoles, http.MethodGet, "/roles", "", "", identity)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Total != 1 || resp.Data[0]["name"] != "admin" {
		t.Fatalf("unexpected envelope: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "tenant_id") {
		t.Fatalf("tenant_id leaked into the response: %s", rec.Body.String())
	}
}

func TestAdminUpdateRole(t *testing.T) {
	identity := Identity{UserID: uuid.New(), TenantID: uuid.New()}
	id := uuid.New()

	tests := []struct {
		name       string
		body       string
		stubErr    error
		wantStatus int
		wantName   string
		wantDesc   string
	}{
		{name: "valid", body: `{"name":"support","description":"helpdesk"}`, wantStatus: http.StatusOK, wantName: "support", wantDesc: "helpdesk"},
		{name: "empty name rejected", body: `{"name":"","description":"x"}`, wantStatus: http.StatusBadRequest},
		{name: "whitespace name rejected", body: `{"name":"   "}`, wantStatus: http.StatusBadRequest},
		{name: "overlong name rejected", body: `{"name":"` + strings.Repeat("a", 101) + `"}`, wantStatus: http.StatusBadRequest},
		{name: "not found", body: `{"name":"support"}`, stubErr: orm.ErrNotFound, wantStatus: http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			roles := &stubAdminRoles{role: Roles{Name: "old"}, err: tt.stubErr}
			h := newAdminHandlerWith(&stubAdminUsers{}, roles)
			rec := serveAdmin(t, h.UpdateRole, http.MethodPut, "/roles/"+id.String(), id.String(), tt.body, identity)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusOK {
				return
			}
			if roles.gotName != tt.wantName || roles.gotDesc != tt.wantDesc {
				t.Errorf("saved (%q,%q), want (%q,%q)", roles.gotName, roles.gotDesc, tt.wantName, tt.wantDesc)
			}
		})
	}
}

func TestAdminGetRole_NotFound(t *testing.T) {
	identity := Identity{UserID: uuid.New(), TenantID: uuid.New()}
	h := newAdminHandlerWith(&stubAdminUsers{}, &stubAdminRoles{err: orm.ErrNotFound})
	rec := serveAdmin(t, h.GetRole, http.MethodGet, "/roles/"+uuid.NewString(), uuid.NewString(), "", identity)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}
