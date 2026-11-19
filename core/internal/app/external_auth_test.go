package app

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/auth/providers"

	"github.com/google/uuid"
)

type fakeDirectory struct{ id providers.ExternalIdentity }

func (f fakeDirectory) Authenticate(context.Context, providers.LDAPConfig, string, string) (providers.ExternalIdentity, error) {
	return f.id, nil
}
func (f fakeDirectory) Check(context.Context, providers.LDAPConfig) error { return nil }

func TestExternalAuth_RoutesAndFallback(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}

	code, body := anon.do(http.MethodGet, "/api/v1/auth/methods", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"local"`) {
		t.Fatalf("methods = %d %s", code, body)
	}
	if code, _ := anon.do(http.MethodGet, "/api/v1/settings/auth", nil); code != http.StatusUnauthorized {
		t.Errorf("anonymous settings = %d", code)
	}
	if code, body := c.do(http.MethodGet, "/api/v1/settings/auth", nil); code != http.StatusOK {
		t.Errorf("admin settings = %d %s", code, body)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/auth/ldap/login", map[string]string{"username": "a", "password": "b"}); code != http.StatusUnauthorized {
		t.Errorf("ldap unconfigured = %d", code)
	}
	if code, _ := anon.do(http.MethodGet, "/api/v1/auth/oidc/providers/nope/authorize?state=s&nonce=n&code_challenge=c", nil); code != http.StatusNotFound {
		t.Errorf("unknown provider = %d", code)
	}
	code, _ = anon.do(http.MethodPost, "/api/v1/auth/login", map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword})
	if code != http.StatusOK {
		t.Errorf("local login = %d", code)
	}
}

func TestExternalAuth_LDAPEndToEnd(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	db := c.a.db.DB

	// Restore the previous auth.methods value (site-wide slot, company uuid.Nil).
	var prev *string
	var raw string
	if err := db.QueryRow(ctx, `SELECT value FROM app_settings WHERE tenant_id=$1 AND company_id=$2 AND key=$3`,
		auth.DevTenantID, uuid.Nil, providers.SettingsKey).Scan(&raw); err == nil {
		prev = &raw
	}
	email := "ext-" + uuid.NewString() + "@example.test"
	t.Cleanup(func() {
		exec := func(q string, args ...any) {
			if _, err := db.Exec(ctx, q, args...); err != nil {
				t.Errorf("cleanup %q: %v", q, err)
			}
		}
		sub := `(SELECT id FROM users WHERE email=$1)`
		exec(`DELETE FROM refresh_tokens WHERE user_id IN `+sub, email)
		exec(`DELETE FROM auth_identity WHERE user_id IN `+sub, email)
		exec(`DELETE FROM user_roles WHERE user_id IN `+sub, email)
		exec(`DELETE FROM users WHERE email=$1`, email)
		if prev != nil {
			exec(`UPDATE app_settings SET value=$4 WHERE tenant_id=$1 AND company_id=$2 AND key=$3`,
				auth.DevTenantID, uuid.Nil, providers.SettingsKey, *prev)
		} else {
			exec(`DELETE FROM app_settings WHERE tenant_id=$1 AND company_id=$2 AND key=$3`,
				auth.DevTenantID, uuid.Nil, providers.SettingsKey)
		}
	})

	code, body := c.do(http.MethodGet, "/api/v1/roles", nil)
	if code != http.StatusOK {
		t.Fatalf("roles = %d %s", code, body)
	}
	var adminRole string
	for _, r := range decode(t, body)["data"].([]any) {
		m := r.(map[string]any)
		if m["technical_name"] == "admin" {
			adminRole, _ = m["id"].(string)
		}
	}
	if adminRole == "" {
		t.Fatalf("no admin role in %s", body)
	}

	code, body = c.do(http.MethodPut, "/api/v1/settings/auth", map[string]any{
		"default": "local", "enabled": []string{"local", "ldap"},
		"ldap": map[string]any{
			"label": "Test", "url": "ldap://127.0.0.1:3890", "bind_dn": "cn=x", "bind_password": "p",
			"base_dn": "ou=people,dc=x", "user_filter": "(uid={username})",
			"email_attr": "mail", "name_attr": "cn", "groups_attr": "memberOf",
		},
		"oidc":         []any{},
		"role_mapping": []map[string]any{{"group": "ext-test", "role_id": adminRole}},
	})
	if code != http.StatusNoContent {
		t.Fatalf("put settings = %d %s", code, body)
	}

	c.a.SetDirectoryForTest(fakeDirectory{id: providers.ExternalIdentity{
		Provider: "ldap", Subject: "uid=" + email, Email: email, EmailVerified: true,
		DisplayName: "Ext Test", Groups: []string{"ext-test"},
	}})
	code, body = anon.do(http.MethodPost, "/api/v1/auth/ldap/login", map[string]string{"username": "u", "password": "p"})
	if code != http.StatusOK {
		t.Fatalf("ldap login = %d %s", code, body)
	}
	if tok, _ := decode(t, body)["access_token"].(string); tok == "" {
		t.Fatalf("no access_token: %s", body)
	}

	// Review Focus 1: whatever the external config (here: LDAP as default,
	// pointing at an unreachable server), local sign-in keeps working.
	code, body = c.do(http.MethodPut, "/api/v1/settings/auth", map[string]any{
		"default": "ldap", "enabled": []string{"local", "ldap"},
		"ldap": map[string]any{
			"label": "Down", "url": "ldaps://127.0.0.1:1", "bind_dn": "cn=x", "bind_password": "p",
			"base_dn": "ou=people,dc=x", "user_filter": "(uid={username})",
			"email_attr": "mail", "name_attr": "cn", "groups_attr": "memberOf",
		},
		"oidc": []any{}, "role_mapping": []any{},
	})
	if code != http.StatusNoContent {
		t.Fatalf("put unreachable settings = %d %s", code, body)
	}
	if code, body := anon.do(http.MethodGet, "/api/v1/auth/methods", nil); code != http.StatusOK || !strings.Contains(string(body), `"local"`) {
		t.Errorf("methods with unreachable ldap = %d %s", code, body)
	}
	if code, body := anon.do(http.MethodPost, "/api/v1/auth/login", map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword}); code != http.StatusOK {
		t.Errorf("local login with unreachable ldap = %d %s", code, body)
	}
}
