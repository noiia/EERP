package providers

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

const SettingsKey = "auth.methods"

var (
	ErrInvalidSettings = errors.New("providers: invalid auth settings")
	providerIDPattern  = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
)

// Methods is the whole auth.methods setting. Secrets travel in plain text
// in memory only; storage holds them sealed (see Store).
type Methods struct {
	Default       string         `json:"default"`
	Enabled       []string       `json:"enabled"`
	LDAP          *LDAPConfig    `json:"ldap,omitempty"`
	OIDC          []OIDCProvider `json:"oidc"`
	RoleMapping   []RoleMapping  `json:"role_mapping"`
	DefaultRoleID *uuid.UUID     `json:"default_role_id"`
	ERPURL        string         `json:"erp_url"`
}

type LDAPConfig struct {
	Label           string `json:"label"`
	URL             string `json:"url"`
	StartTLS        bool   `json:"start_tls"`
	BindDN          string `json:"bind_dn"`
	BindPassword    string `json:"bind_password,omitempty"`
	BaseDN          string `json:"base_dn"`
	UserFilter      string `json:"user_filter"`
	EmailAttr       string `json:"email_attr"`
	NameAttr        string `json:"name_attr"`
	GroupsAttr      string `json:"groups_attr"`
	GroupSearchBase string `json:"group_search_base"`
	GroupFilter     string `json:"group_filter"`
}

type OIDCProvider struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Issuer       string `json:"issuer"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	Scopes       string `json:"scopes"`
	GroupsClaim  string `json:"groups_claim"`
	TrustEmail   bool   `json:"trust_email"`
}

type RoleMapping struct {
	Group  string    `json:"group"`
	RoleID uuid.UUID `json:"role_id"`
}

// LLDAPDefaults are LLDAP's schema defaults (ou=people, uid, mail, memberOf).
func LLDAPDefaults(baseDN string) LDAPConfig {
	return LDAPConfig{
		Label: "LLDAP", BaseDN: "ou=people," + baseDN,
		UserFilter: "(&(objectClass=person)(uid={username}))",
		EmailAttr:  "mail", NameAttr: "cn", GroupsAttr: "memberOf",
	}
}

func (m Methods) defaultID() string {
	if m.Default == "" {
		return "local"
	}
	return m.Default
}

// Provider returns the OIDC provider with that id.
func (m Methods) Provider(id string) (OIDCProvider, bool) {
	for _, p := range m.OIDC {
		if p.ID == id {
			return p, true
		}
	}
	return OIDCProvider{}, false
}

// CallbackURL is the OIDC redirect URI to register at every provider.
func (m Methods) CallbackURL() string {
	return strings.TrimRight(m.ERPURL, "/") + "/api/auth/oidc/callback"
}

// Allows reports whether the login screen offers method id (the default or
// an enabled alternative). Local is always allowed (?method=local fallback).
func (m Methods) Allows(id string) bool {
	if id == "local" {
		return true
	}
	if id == m.defaultID() {
		return m.configured(id)
	}
	for _, e := range m.Enabled {
		if e == id {
			return m.configured(id)
		}
	}
	return false
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidSettings, fmt.Sprintf(format, args...))
}

func (m Methods) configured(id string) bool {
	switch {
	case id == "local":
		return true
	case id == "ldap":
		return m.LDAP != nil
	case strings.HasPrefix(id, "oidc:"):
		_, ok := m.Provider(strings.TrimPrefix(id, "oidc:"))
		return ok
	}
	return false
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Validate checks the whole setting; roleExists reports whether a role id
// exists in the auth tenant.
func (m Methods) Validate(roleExists func(uuid.UUID) bool) error {
	for _, id := range append([]string{m.defaultID()}, m.Enabled...) {
		if !m.configured(id) {
			return invalid("method %q is not configured", id)
		}
	}
	seen := map[string]bool{}
	for _, p := range m.OIDC {
		if !providerIDPattern.MatchString(p.ID) || seen[p.ID] {
			return invalid("provider id %q must be lowercase-dash and unique", p.ID)
		}
		seen[p.ID] = true
		u, err := url.Parse(p.Issuer)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return invalid("provider %q issuer must be an https URL", p.ID)
		}
		if p.ClientID == "" {
			return invalid("provider %q needs a client id", p.ID)
		}
	}
	if len(m.OIDC) > 0 {
		u, err := url.Parse(m.ERPURL)
		if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname()))) ||
			u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.Fragment != "" ||
			(u.Path != "" && u.Path != "/") {
			return invalid("erp_url must be the ERP's public https origin")
		}
	}
	if l := m.LDAP; l != nil {
		u, err := url.Parse(l.URL)
		if err != nil || (u.Scheme != "ldap" && u.Scheme != "ldaps") || u.Host == "" {
			return invalid("ldap url must be ldap:// or ldaps://")
		}
		if u.Scheme == "ldap" && !l.StartTLS && !isLoopback(u.Hostname()) {
			return invalid("plain ldap:// needs StartTLS outside loopback")
		}
		if l.BaseDN == "" || !strings.Contains(l.UserFilter, "{username}") {
			return invalid("ldap needs a base DN and a user filter containing {username}")
		}
	}
	for _, rm := range m.RoleMapping {
		if strings.TrimSpace(rm.Group) == "" || !roleExists(rm.RoleID) {
			return invalid("role mapping %q points at an unknown role", rm.Group)
		}
	}
	if m.DefaultRoleID != nil && !roleExists(*m.DefaultRoleID) {
		return invalid("default role is unknown")
	}
	return nil
}

type PublicMethod struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // "password" | "redirect"
	Label string `json:"label"`
}

type PublicMethods struct {
	Default      PublicMethod   `json:"default"`
	Alternatives []PublicMethod `json:"alternatives"`
}

func (m Methods) publicOf(id string) (PublicMethod, bool) {
	switch {
	case id == "local":
		return PublicMethod{ID: "local", Kind: "password"}, true
	case id == "ldap" && m.LDAP != nil:
		return PublicMethod{ID: "ldap", Kind: "password", Label: m.LDAP.Label}, true
	case strings.HasPrefix(id, "oidc:"):
		if p, ok := m.Provider(strings.TrimPrefix(id, "oidc:")); ok {
			return PublicMethod{ID: id, Kind: "redirect", Label: p.Label}, true
		}
	}
	return PublicMethod{}, false
}

// Public is what the anonymous login screen may know: ids, kinds, labels.
func (m Methods) Public() PublicMethods {
	out := PublicMethods{Alternatives: []PublicMethod{}}
	def, ok := m.publicOf(m.defaultID())
	if !ok {
		def, _ = m.publicOf("local")
	}
	out.Default = def
	for _, id := range m.Enabled {
		if id == def.ID {
			continue
		}
		if p, ok := m.publicOf(id); ok {
			out.Alternatives = append(out.Alternatives, p)
		}
	}
	return out
}
