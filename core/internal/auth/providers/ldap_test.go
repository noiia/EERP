package providers

import (
	"context"
	"core/orm/access"
	"errors"
	"github.com/go-ldap/ldap/v3"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type fakeDirectory struct {
	users map[string]struct {
		password string
		id       ExternalIdentity
	}
	calls    int
	checkErr error
	authErr  error
}

func (f *fakeDirectory) Authenticate(_ context.Context, _ LDAPConfig, username, password string) (ExternalIdentity, error) {
	f.calls++
	if f.authErr != nil {
		return ExternalIdentity{}, f.authErr
	}
	u, ok := f.users[username]
	if !ok || u.password != password {
		return ExternalIdentity{}, ErrInvalidCredentials
	}
	return u.id, nil
}
func (f *fakeDirectory) Check(context.Context, LDAPConfig) error { return f.checkErr }

type fakeSessions struct{ issued uuid.UUID }

func (f *fakeSessions) IssueSessionForUser(c *echo.Context, id uuid.UUID) error {
	f.issued = id
	return c.JSON(http.StatusOK, map[string]string{"access_token": "t"})
}

func TestEscapeFilter(t *testing.T) {
	got := userFilter("(&(objectClass=person)(uid={username}))", `a*)(uid=*`)
	if strings.Contains(got, "*)(") || !strings.Contains(got, `a\2a\29\28uid=\2a`) {
		t.Errorf("filter = %q", got)
	}
}

func ldapTestHandler(t *testing.T) (*Handler, *fakeDirectory, *fakeSessions, uuid.UUID, LDAPConfig) {
	dir := &fakeDirectory{users: map[string]struct {
		password string
		id       ExternalIdentity
	}{"alice": {"pw", ExternalIdentity{Provider: "ldap", Subject: "uid=alice", Email: "alice@x", EmailVerified: true, Groups: []string{"erp"}}}}}
	sessions := &fakeSessions{}
	h, _ := newTestHandler(t, uuid.New())
	h.deps.Directory = dir
	h.deps.Sessions = sessions
	user := uuid.New()
	h.provision = func(_ context.Context, _ uuid.UUID, id ExternalIdentity, _ Methods) (uuid.UUID, error) {
		if id.Subject != "uid=alice" {
			return uuid.Nil, ErrRefused
		}
		return user, nil
	}
	ldap := LLDAPDefaults("dc=x")
	ldap.URL = "ldaps://ldap.example.com"
	if err := h.deps.Store.Save(context.Background(), h.deps.Tenant, Methods{Default: "ldap", LDAP: &ldap}); err != nil {
		t.Fatal(err)
	}
	return h, dir, sessions, user, ldap
}

func TestLDAPLogin(t *testing.T) {
	h, dir, sessions, user, ldap := ldapTestHandler(t)

	if rec := call(t, h, h.LDAPLogin, http.MethodPost, `{"username":"alice","password":"pw"}`); rec.Code != http.StatusOK || sessions.issued != user {
		t.Fatalf("good login = %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{
		`{"username":"alice","password":"nope"}`,
		`{"username":"bob","password":"pw"}`,
	} {
		rec := call(t, h, h.LDAPLogin, http.MethodPost, body)
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "Invalid username or password.") {
			t.Errorf("%s = %d %s", body, rec.Code, rec.Body.String())
		}
	}
	before := dir.calls
	for _, body := range []string{`{"username":"alice","password":""}`, `{"username":"  ","password":"pw"}`} {
		if rec := call(t, h, h.LDAPLogin, http.MethodPost, body); rec.Code != http.StatusUnauthorized || dir.calls != before {
			t.Errorf("%s must be refused before any directory call: %d, calls %d→%d", body, rec.Code, before, dir.calls)
		}
	}
	// A refused provisioning is the same 401.
	h.provision = func(context.Context, uuid.UUID, ExternalIdentity, Methods) (uuid.UUID, error) {
		return uuid.Nil, ErrRefused
	}
	if rec := call(t, h, h.LDAPLogin, http.MethodPost, `{"username":"alice","password":"pw"}`); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "Invalid username or password.") {
		t.Errorf("refused provisioning = %d %s", rec.Code, rec.Body.String())
	}
	// LDAP not offered on the login screen → 401.
	_ = h.deps.Store.Save(context.Background(), h.deps.Tenant, Methods{Default: "local", LDAP: &ldap})
	before = dir.calls
	if rec := call(t, h, h.LDAPLogin, http.MethodPost, `{"username":"alice","password":"pw"}`); rec.Code != http.StatusUnauthorized || dir.calls != before {
		t.Errorf("disabled ldap = %d", rec.Code)
	}
}

func TestLDAPLoginDirectoryDownIsNot401(t *testing.T) {
	h, dir, _, _, _ := ldapTestHandler(t)
	dir.authErr = errors.New("dial tcp: refused")
	c := echo.New().NewContext(requestFor(h, `{"username":"alice","password":"pw"}`), httptest.NewRecorder())
	if err := h.LDAPLogin(c); err == nil {
		t.Fatal("directory outage must surface as an error (500), not a 401")
	}
}

func TestTestSettingsLDAP(t *testing.T) {
	h, dir, _, _, _ := ldapTestHandler(t)
	rec := call(t, h, h.TestSettings, http.MethodPost, `{"method":"ldap"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("ok = %d %s", rec.Code, rec.Body.String())
	}
	dir.checkErr = errors.New("bind failed")
	rec = call(t, h, h.TestSettings, http.MethodPost, `{"method":"ldap"}`)
	if !strings.Contains(rec.Body.String(), `"ok":false`) || !strings.Contains(rec.Body.String(), "bind failed") {
		t.Errorf("failure = %d %s", rec.Code, rec.Body.String())
	}
	if rec := call(t, h, h.TestSettings, http.MethodPost, `{"method":"x"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown = %d", rec.Code)
	}
	if rec := callAs(t, h.TestSettings, uuid.New(), http.MethodPost, `{"method":"ldap"}`); rec.Code != http.StatusForbidden {
		t.Errorf("other tenant = %d", rec.Code)
	}
}

func requestFor(h *Handler, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req = req.WithContext(access.WithTenant(req.Context(), h.deps.Tenant))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestLDAPErrorClassification(t *testing.T) {
	for code, want := range map[uint16]bool{
		ldap.LDAPResultInvalidCredentials:       true,
		ldap.LDAPResultConstraintViolation:      true,
		ldap.LDAPResultUnwillingToPerform:       true,
		ldap.LDAPResultInsufficientAccessRights: true,
		ldap.LDAPResultInvalidDNSyntax:          true,
		ldap.LDAPResultBusy:                     false,
		ldap.LDAPResultUnavailable:              false,
		ldap.LDAPResultSizeLimitExceeded:        false, // handled on the search, not the bind
	} {
		if got := isAccountStateError(ldap.NewError(code, errors.New("x"))); got != want {
			t.Errorf("code %d: got %v want %v", code, got, want)
		}
	}
	if isAccountStateError(errors.New("network")) {
		t.Error("plain error classified as account state")
	}
}
