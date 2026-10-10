package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/orm/access"
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

func call(t *testing.T, h *Handler, fn echo.HandlerFunc, method, body string) *httptest.ResponseRecorder {
	return callAs(t, fn, h.deps.Tenant, method, body)
}

// callAs stamps tenant on the request context.
func callAs(t *testing.T, fn echo.HandlerFunc, tenant uuid.UUID, method, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req = req.WithContext(access.WithTenant(req.Context(), tenant))
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
	if rec := call(t, h, h.PutSettings, http.MethodPut, body); rec.Code != http.StatusNoContent {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}
	stored := mem[SettingsKey]
	if strings.Contains(stored, "p4ss") || strings.Contains(stored, "cl1ent") {
		t.Fatalf("secrets stored in clear: %s", stored)
	}
	rec := call(t, h, h.GetSettings, http.MethodGet, "")
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
	if rec := call(t, h, h.PutSettings, http.MethodPut, keep); rec.Code != http.StatusNoContent {
		t.Fatalf("put keep = %d", rec.Code)
	}
	m, _ := h.deps.Store.Load(context.Background(), h.deps.Tenant)
	if m.LDAP.BindPassword != "p4ss" || m.OIDC[0].ClientSecret != "cl1ent" {
		t.Errorf("secrets lost: %+v %+v", m.LDAP, m.OIDC)
	}
}

func TestSettingsValidationAndPublic(t *testing.T) {
	h, _ := newTestHandler(t, uuid.New())
	if rec := call(t, h, h.PutSettings, http.MethodPut, `{"default":"oidc:missing"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid settings = %d, want 400", rec.Code)
	}
	rec := call(t, h, h.PublicMethods, http.MethodGet, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"local"`) {
		t.Errorf("public with nothing set = %d %s", rec.Code, rec.Body.String())
	}
}

func TestPutSettingsNoTenantConflict(t *testing.T) {
	h, _ := newTestHandler(t, uuid.New())
	h.deps.Tenant = uuid.Nil
	if rec := call(t, h, h.PutSettings, http.MethodPut, `{}`); rec.Code != http.StatusConflict {
		t.Errorf("no tenant = %d, want 409", rec.Code)
	}
}

const ldapBody = `{"ldap":{"label":"L","url":"ldaps://a.example.com","bind_dn":"uid=admin","bind_password":"%s","base_dn":"dc=x","user_filter":"(uid={username})"}}`
const oidcBody = `{"oidc":[{"id":"corp","label":"Corp","issuer":"%s","client_id":"erp","client_secret":"%s"}],"erp_url":"https://erp.example.com"}`

func TestSecretNotKeptWhenDestinationChanges(t *testing.T) {
	h, mem := newTestHandler(t, uuid.New())
	if rec := call(t, h, h.PutSettings, http.MethodPut, fmt.Sprintf(ldapBody, "p4ss")); rec.Code != http.StatusNoContent {
		t.Fatalf("seed ldap = %d %s", rec.Code, rec.Body.String())
	}
	before := mem[SettingsKey]
	changed := strings.Replace(fmt.Sprintf(ldapBody, ""), "a.example.com", "evil.example.com", 1)
	if rec := call(t, h, h.PutSettings, http.MethodPut, changed); rec.Code != http.StatusBadRequest {
		t.Errorf("ldap url change without password = %d, want 400", rec.Code)
	}
	if mem[SettingsKey] != before {
		t.Error("stored settings changed on a refused save")
	}
	dn := strings.Replace(fmt.Sprintf(ldapBody, ""), "uid=admin", "uid=other", 1)
	if rec := call(t, h, h.PutSettings, http.MethodPut, dn); rec.Code != http.StatusBadRequest {
		t.Errorf("ldap bind_dn change without password = %d, want 400", rec.Code)
	}

	h, mem = newTestHandler(t, uuid.New())
	if rec := call(t, h, h.PutSettings, http.MethodPut, fmt.Sprintf(oidcBody, "https://id.example.com", "cl1ent")); rec.Code != http.StatusNoContent {
		t.Fatalf("seed oidc = %d %s", rec.Code, rec.Body.String())
	}
	before = mem[SettingsKey]
	if rec := call(t, h, h.PutSettings, http.MethodPut, fmt.Sprintf(oidcBody, "https://evil.example.com", "")); rec.Code != http.StatusBadRequest {
		t.Errorf("oidc issuer change without secret = %d, want 400", rec.Code)
	}
	if mem[SettingsKey] != before {
		t.Error("stored settings changed on a refused save")
	}
	if rec := call(t, h, h.PutSettings, http.MethodPut, fmt.Sprintf(oidcBody, "https://evil.example.com", "new")); rec.Code != http.StatusNoContent {
		t.Errorf("issuer change with new secret = %d, want 204", rec.Code)
	}
}

func TestCorruptStoredSettingsRecoverable(t *testing.T) {
	h, mem := newTestHandler(t, uuid.New())
	mem[SettingsKey] = "{junk"
	rec := call(t, h, h.PublicMethods, http.MethodGet, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"local"`) {
		t.Errorf("public with junk = %d %s", rec.Code, rec.Body.String())
	}
	if rec := call(t, h, h.PutSettings, http.MethodPut, `{}`); rec.Code != http.StatusNoContent {
		t.Errorf("put over junk = %d %s", rec.Code, rec.Body.String())
	}
}

func TestSettingsRequireAuthTenant(t *testing.T) {
	h, _ := newTestHandler(t, uuid.New())
	other := uuid.New()
	if rec := callAs(t, h.GetSettings, other, http.MethodGet, ""); rec.Code != http.StatusForbidden {
		t.Errorf("GET other tenant = %d, want 403", rec.Code)
	}
	if rec := callAs(t, h.PutSettings, other, http.MethodPut, `{}`); rec.Code != http.StatusForbidden {
		t.Errorf("PUT other tenant = %d, want 403", rec.Code)
	}
	h.deps.Tenant = uuid.Nil
	if rec := callAs(t, h.GetSettings, uuid.Nil, http.MethodGet, ""); rec.Code != http.StatusConflict {
		t.Errorf("GET no tenant = %d, want 409", rec.Code)
	}
}

func TestPublicMethodsExposeOnlyLabels(t *testing.T) {
	h, _ := newTestHandler(t, uuid.New())
	body := `{"default":"oidc:corp","enabled":["ldap","local"],
	  "ldap":{"label":"LLDAP","url":"ldaps://ldap.example.com","bind_dn":"uid=admin","bind_password":"p4ss","base_dn":"dc=x","user_filter":"(uid={username})"},
	  "oidc":[{"id":"corp","label":"Corp SSO","issuer":"https://id.example.com","client_id":"erp-client","client_secret":"cl1ent"}],"erp_url":"https://erp.example.com"}`
	if rec := call(t, h, h.PutSettings, http.MethodPut, body); rec.Code != http.StatusNoContent {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}
	rec := call(t, h, h.PublicMethods, http.MethodGet, "")
	var got PublicMethods
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Default != (PublicMethod{ID: "oidc:corp", Kind: "redirect", Label: "Corp SSO"}) {
		t.Errorf("default = %+v", got.Default)
	}
	want := []PublicMethod{{ID: "ldap", Kind: "password", Label: "LLDAP"}, {ID: "local", Kind: "password"}}
	if len(got.Alternatives) != 2 || got.Alternatives[0] != want[0] || got.Alternatives[1] != want[1] {
		t.Errorf("alternatives = %+v", got.Alternatives)
	}
	for _, leak := range []string{"issuer", "id.example.com", "client_id", "erp-client", "ldap.example.com", "bind_dn", "uid=admin", "p4ss", "cl1ent", "v1:"} {
		if strings.Contains(rec.Body.String(), leak) {
			t.Errorf("anonymous JSON leaks %q: %s", leak, rec.Body.String())
		}
	}
}
