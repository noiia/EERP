package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type memSettings map[string]string

func (m memSettings) Get(_ context.Context, _, _ uuid.UUID, key string) (string, bool, error) {
	v, ok := m[key]
	return v, ok, nil
}
func (m memSettings) Set(_ context.Context, _, _ uuid.UUID, key, value string) error {
	m[key] = value
	return nil
}

func newTestHandler(t *testing.T, role uuid.UUID) (*Handler, memSettings) {
	box, _ := NewSecretBox("test-master-key")
	mem := memSettings{}
	h := NewHandler(Deps{
		Store:  NewStore(mem, box),
		Tenant: uuid.New(),
		Roles: func(context.Context, uuid.UUID) (map[uuid.UUID]bool, error) {
			return map[uuid.UUID]bool{role: true}, nil
		},
	})
	return h, mem
}

func call(t *testing.T, fn echo.HandlerFunc, method, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := fn(echo.New().NewContext(req, rec)); err != nil {
		if he, ok := err.(*echo.HTTPError); ok {
			rec.Code = he.Code
		} else {
			t.Fatal(err)
		}
	}
	return rec
}

func TestSettingsSecretsWriteOnlyAndEncrypted(t *testing.T) {
	role := uuid.New()
	h, mem := newTestHandler(t, role)
	body := `{"default":"ldap","ldap":{"label":"LLDAP","url":"ldaps://ldap.example.com","bind_dn":"uid=admin","bind_password":"p4ss","base_dn":"dc=x","user_filter":"(uid={username})"},
	          "oidc":[{"id":"corp","label":"Corp","issuer":"https://id.example.com","client_id":"erp","client_secret":"cl1ent"}],
	          "role_mapping":[{"group":"erp","role_id":"` + role.String() + `"}],"erp_url":"https://erp.example.com"}`
	if rec := call(t, h.PutSettings, http.MethodPut, body); rec.Code != http.StatusNoContent {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}
	stored := mem[SettingsKey]
	if strings.Contains(stored, "p4ss") || strings.Contains(stored, "cl1ent") {
		t.Fatalf("secrets stored in clear: %s", stored)
	}
	rec := call(t, h.GetSettings, http.MethodGet, "")
	if strings.Contains(rec.Body.String(), "p4ss") || strings.Contains(rec.Body.String(), "cl1ent") || strings.Contains(rec.Body.String(), "v1:") {
		t.Fatalf("GET leaked a secret: %s", rec.Body.String())
	}
	if n := strings.Count(rec.Body.String(), `"ldap":`); n != 1 {
		t.Errorf("ldap keys = %d, want 1: %s", n, rec.Body.String())
	}
	if n := strings.Count(rec.Body.String(), `"oidc":`); n != 1 {
		t.Errorf("oidc keys = %d, want 1: %s", n, rec.Body.String())
	}
	var got struct {
		LDAP struct {
			HasBindPassword bool `json:"has_bind_password"`
		} `json:"ldap"`
		OIDC []struct {
			HasClientSecret bool `json:"has_client_secret"`
		} `json:"oidc"`
		CallbackURL string `json:"callback_url"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if !got.LDAP.HasBindPassword || len(got.OIDC) != 1 || !got.OIDC[0].HasClientSecret || got.CallbackURL != "https://erp.example.com/api/auth/oidc/callback" {
		t.Errorf("GET = %s", rec.Body.String())
	}
	// An empty secret keeps the stored one.
	keep := strings.Replace(strings.Replace(body, `"p4ss"`, `""`, 1), `"cl1ent"`, `""`, 1)
	if rec := call(t, h.PutSettings, http.MethodPut, keep); rec.Code != http.StatusNoContent {
		t.Fatalf("put keep = %d", rec.Code)
	}
	m, _ := h.deps.Store.Load(context.Background(), h.deps.Tenant)
	if m.LDAP.BindPassword != "p4ss" || m.OIDC[0].ClientSecret != "cl1ent" {
		t.Errorf("secrets lost: %+v %+v", m.LDAP, m.OIDC)
	}
}

func TestSettingsValidationAndPublic(t *testing.T) {
	h, _ := newTestHandler(t, uuid.New())
	if rec := call(t, h.PutSettings, http.MethodPut, `{"default":"oidc:missing"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid settings = %d, want 400", rec.Code)
	}
	rec := call(t, h.PublicMethods, http.MethodGet, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"local"`) {
		t.Errorf("public with nothing set = %d %s", rec.Code, rec.Body.String())
	}
}

func TestPutSettingsNoTenantConflict(t *testing.T) {
	h, _ := newTestHandler(t, uuid.New())
	h.deps.Tenant = uuid.Nil
	if rec := call(t, h.PutSettings, http.MethodPut, `{}`); rec.Code != http.StatusConflict {
		t.Errorf("no tenant = %d, want 409", rec.Code)
	}
}
