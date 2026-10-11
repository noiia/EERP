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
	hostnamePattern    = regexp.MustCompile(`^(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
)

// Methods is the whole auth.methods setting. Secrets travel in plain text
// in memory only; storage holds them sealed (see Store).
type Methods struct {
	Default     string         `json:"default"`
	Enabled     []string       `json:"enabled"`
	LDAP        *LDAPConfig    `json:"ldap,omitempty"`
	OIDC        []OIDCProvider `json:"oidc"`
	RoleMapping []RoleMapping  `json:"role_mapping"`
	ERPURL      string         `json:"erp_url"`
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
	// DefaultRoleID is granted to an LDAP user none of whose groups is mapped
	// (nil = refuse such users unless they hold a manual role).
	DefaultRoleID *uuid.UUID `json:"default_role_id"`
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
	// DefaultRoleID is granted to a user of this provider none of whose
	// groups is mapped. Never inherited from another method: on a public IdP
	// (Google, Microsoft) a default role admits every account of that IdP.
	DefaultRoleID *uuid.UUID `json:"default_role_id"`
	// AllowedDomains, when non-empty, admits only identities whose verified
	// email domain is listed.
	AllowedDomains []string `json:"allowed_domains"`
}

// RoleMapping grants RoleID to a user holding Group. Method scopes the row:
// "" applies to every external method, else "ldap" or "oidc:<id>".
type RoleMapping struct {
	Group  string    `json:"group"`
	RoleID uuid.UUID `json:"role_id"`
	Method string    `json:"method"`
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
		if p.DefaultRoleID != nil && !roleExists(*p.DefaultRoleID) {
			return invalid("provider %q default role is unknown", p.ID)
		}
		for _, d := range p.AllowedDomains {
			if !hostnamePattern.MatchString(strings.TrimSpace(d)) {
				return invalid("provider %q allowed domain %q is not a domain name", p.ID, d)
			}
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
		if strings.TrimSpace(l.BindDN) == "" {
			return invalid("ldap needs a service account (bind DN)")
		}
		if l.DefaultRoleID != nil && !roleExists(*l.DefaultRoleID) {
			return invalid("ldap default role is unknown")
		}
	}
	for _, rm := range m.RoleMapping {
		if strings.TrimSpace(rm.Group) == "" || !roleExists(rm.RoleID) {
			return invalid("role mapping %q points at an unknown role", rm.Group)
		}
		if rm.Method != "" && (rm.Method == "local" || !m.configured(rm.Method)) {
			return invalid("role mapping %q is scoped to unconfigured method %q", rm.Group, rm.Method)
		}
	}
	return nil
}

// DefaultRole is method's own default role ("ldap" or "oidc:<id>"), if any.
func (m Methods) DefaultRole(method string) *uuid.UUID {
	switch {
	case method == "ldap" && m.LDAP != nil:
		return m.LDAP.DefaultRoleID
	case strings.HasPrefix(method, "oidc:"):
		if p, ok := m.Provider(strings.TrimPrefix(method, "oidc:")); ok {
			return p.DefaultRoleID
		}
	}
	return nil
}

// DomainAllowed reports whether id passes its OIDC provider's
// allowed_domains (always true for LDAP or an empty list): a verified email
// whose domain, after the last "@", is listed.
func (m Methods) DomainAllowed(id ExternalIdentity) bool {
	if !strings.HasPrefix(id.Provider, "oidc:") {
		return true
	}
	p, _ := m.Provider(strings.TrimPrefix(id.Provider, "oidc:"))
	if len(p.AllowedDomains) == 0 {
		return true
	}
	at := strings.LastIndex(id.Email, "@")
	if !id.EmailVerified || at < 0 {
		return false
	}
	domain := strings.ToLower(strings.TrimSpace(id.Email[at+1:]))
	for _, d := range p.AllowedDomains {
		if domain != "" && domain == strings.ToLower(strings.TrimSpace(d)) {
			return true
		}
	}
	return false
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
