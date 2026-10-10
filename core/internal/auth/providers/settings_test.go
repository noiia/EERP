// core/internal/auth/providers/settings_test.go
package providers

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestMethodsValidate(t *testing.T) {
	admin := uuid.New()
	exists := func(id uuid.UUID) bool { return id == admin }
	ldap := LLDAPDefaults("dc=example,dc=com")
	ldap.URL = "ldaps://ldap.example.com"
	ldap.BindDN = "uid=admin,ou=people,dc=example,dc=com"
	okOIDC := OIDCProvider{ID: "authentik", Label: "Authentik", Issuer: "https://auth.example.com/application/o/erp/", ClientID: "erp"}

	tests := []struct {
		name string
		m    Methods
		ok   bool
	}{
		{"local only", Methods{Default: "local"}, true},
		{"empty default means local", Methods{}, true},
		{"ldap default", Methods{Default: "ldap", LDAP: &ldap}, true},
		{"ldap default without config", Methods{Default: "ldap"}, false},
		{"oidc needs erp_url", Methods{Default: "oidc:authentik", OIDC: []OIDCProvider{okOIDC}}, false},
		{"oidc ok", Methods{Default: "local", Enabled: []string{"oidc:authentik"}, OIDC: []OIDCProvider{okOIDC}, ERPURL: "https://erp.example.com"}, true},
		{"erp_url path", Methods{OIDC: []OIDCProvider{okOIDC}, ERPURL: "https://erp.example.com/x"}, false},
		{"erp_url query", Methods{OIDC: []OIDCProvider{okOIDC}, ERPURL: "https://erp.example.com?y=1"}, false},
		{"erp_url userinfo", Methods{OIDC: []OIDCProvider{okOIDC}, ERPURL: "https://user:pw@erp.example.com"}, false},
		{"erp_url no host", Methods{OIDC: []OIDCProvider{okOIDC}, ERPURL: "https://:443"}, false},
		{"erp_url trailing slash", Methods{OIDC: []OIDCProvider{okOIDC}, ERPURL: "https://erp.example.com/"}, true},
		{"unknown enabled method", Methods{Default: "local", Enabled: []string{"oidc:nope"}}, false},
		{"bad provider id", Methods{OIDC: []OIDCProvider{{ID: "Bad_Id", Issuer: "https://x", ClientID: "c"}}, ERPURL: "https://erp"}, false},
		{"duplicate provider id", Methods{OIDC: []OIDCProvider{okOIDC, okOIDC}, ERPURL: "https://erp"}, false},
		{"issuer must be https", Methods{OIDC: []OIDCProvider{{ID: "a", Issuer: "http://x", ClientID: "c"}}, ERPURL: "https://erp"}, false},
		{"plain ldap remote", Methods{Default: "ldap", LDAP: &LDAPConfig{URL: "ldap://ldap.example.com", BaseDN: "dc=x", UserFilter: "(uid={username})"}}, false},
		{"plain ldap loopback", Methods{Default: "ldap", LDAP: &LDAPConfig{URL: "ldap://127.0.0.1:3890", BaseDN: "dc=x", UserFilter: "(uid={username})"}}, true},
		{"filter needs placeholder", Methods{Default: "ldap", LDAP: &LDAPConfig{URL: "ldaps://x", BaseDN: "dc=x", UserFilter: "(uid=bob)"}}, false},
		{"mapped role exists", Methods{RoleMapping: []RoleMapping{{Group: "erp-admins", RoleID: admin}}}, true},
		{"mapped role unknown", Methods{RoleMapping: []RoleMapping{{Group: "erp-admins", RoleID: uuid.New()}}}, false},
		{"default role unknown", Methods{DefaultRoleID: ptr(uuid.New())}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.m.Validate(exists)
			if tt.ok && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tt.ok && !errors.Is(err, ErrInvalidSettings) {
				t.Fatalf("err = %v, want ErrInvalidSettings", err)
			}
		})
	}
}

func TestMethodsPublic(t *testing.T) {
	ldap := LLDAPDefaults("dc=x")
	ldap.Label = "Company directory"
	m := Methods{
		Default: "oidc:authentik",
		Enabled: []string{"ldap", "local"},
		LDAP:    &ldap,
		OIDC:    []OIDCProvider{{ID: "authentik", Label: "Authentik", Issuer: "https://a", ClientID: "c", ClientSecret: "never"}},
		ERPURL:  "https://erp.example.com",
	}
	p := m.Public()
	if p.Default != (PublicMethod{ID: "oidc:authentik", Kind: "redirect", Label: "Authentik"}) {
		t.Errorf("default = %+v", p.Default)
	}
	want := []PublicMethod{{ID: "ldap", Kind: "password", Label: "Company directory"}, {ID: "local", Kind: "password", Label: ""}}
	if len(p.Alternatives) != 2 || p.Alternatives[0] != want[0] || p.Alternatives[1] != want[1] {
		t.Errorf("alternatives = %+v", p.Alternatives)
	}
	if (Methods{}).Public().Default.ID != "local" {
		t.Error("zero settings must publish local")
	}
	if got := m.CallbackURL(); got != "https://erp.example.com/api/auth/oidc/callback" {
		t.Errorf("callback = %q", got)
	}
}

func ptr[T any](v T) *T { return &v }

func TestMethodsAllows(t *testing.T) {
	m := Methods{Default: "ldap"}
	if m.Allows("ldap") {
		t.Error("unconfigured ldap must not be allowed")
	}
	if !m.Allows("local") {
		t.Error("local is always allowed")
	}
}
