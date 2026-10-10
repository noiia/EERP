package providers

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// ErrInvalidCredentials: unknown user, several matches or a wrong password —
// never distinguished to the caller.
var ErrInvalidCredentials = errors.New("providers: invalid credentials")

type Directory interface {
	Authenticate(ctx context.Context, cfg LDAPConfig, username, password string) (ExternalIdentity, error)
	Check(ctx context.Context, cfg LDAPConfig) error
}

type LDAPDirectory struct{ Timeout time.Duration }

func userFilter(filter, username string) string {
	return strings.ReplaceAll(filter, "{username}", ldap.EscapeFilter(username))
}

func (d LDAPDirectory) dial(cfg LDAPConfig) (*ldap.Conn, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil {
		return nil, err
	}
	timeout := d.Timeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	conn, err := ldap.DialURL(cfg.URL, ldap.DialWithDialer(&net.Dialer{Timeout: timeout}),
		ldap.DialWithTLSConfig(&tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}))
	if err != nil {
		return nil, fmt.Errorf("ldap: dial: %w", err)
	}
	conn.SetTimeout(timeout)
	if u.Scheme == "ldap" && cfg.StartTLS {
		if err := conn.StartTLS(&tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}); err != nil {
			conn.Close()
			return nil, fmt.Errorf("ldap: starttls: %w", err)
		}
	}
	return conn, nil
}

func (d LDAPDirectory) Check(_ context.Context, cfg LDAPConfig) error {
	conn, err := d.dial(cfg)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
		return fmt.Errorf("ldap: service bind: %w", err)
	}
	_, err = conn.Search(ldap.NewSearchRequest(cfg.BaseDN, ldap.ScopeBaseObject, ldap.NeverDerefAliases, 1, 5, false, "(objectClass=*)", []string{"dn"}, nil))
	return err
}

func (d LDAPDirectory) Authenticate(_ context.Context, cfg LDAPConfig, username, password string) (ExternalIdentity, error) {
	if username == "" || password == "" {
		return ExternalIdentity{}, ErrInvalidCredentials // never an anonymous bind
	}
	conn, err := d.dial(cfg)
	if err != nil {
		return ExternalIdentity{}, err
	}
	defer conn.Close()
	if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err != nil {
		return ExternalIdentity{}, fmt.Errorf("ldap: service bind: %w", err)
	}
	attrs := []string{"dn", "displayName"}
	for _, a := range []string{cfg.EmailAttr, cfg.NameAttr} {
		if a != "" {
			attrs = append(attrs, a)
		}
	}
	if cfg.GroupsAttr != "" {
		attrs = append(attrs, cfg.GroupsAttr)
	}
	res, err := conn.Search(ldap.NewSearchRequest(cfg.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 2, 10, false,
		userFilter(cfg.UserFilter, username), attrs, nil))
	if err != nil {
		return ExternalIdentity{}, fmt.Errorf("ldap: search: %w", err)
	}
	if len(res.Entries) != 1 {
		return ExternalIdentity{}, ErrInvalidCredentials
	}
	entry := res.Entries[0]
	if err := conn.Bind(entry.DN, password); err != nil {
		if ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
			return ExternalIdentity{}, ErrInvalidCredentials
		}
		return ExternalIdentity{}, fmt.Errorf("ldap: user bind: %w", err)
	}
	name := entry.GetAttributeValue(cfg.NameAttr)
	if name == "" {
		name = entry.GetAttributeValue("displayName")
	}
	groups := groupNames(entry.GetAttributeValues(cfg.GroupsAttr))
	if cfg.GroupSearchBase != "" && cfg.GroupFilter != "" {
		if err := conn.Bind(cfg.BindDN, cfg.BindPassword); err == nil {
			gr, err := conn.Search(ldap.NewSearchRequest(cfg.GroupSearchBase, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 10, false,
				strings.ReplaceAll(cfg.GroupFilter, "{dn}", ldap.EscapeFilter(entry.DN)), []string{"cn"}, nil))
			if err == nil {
				for _, g := range gr.Entries {
					groups = append(groups, g.GetAttributeValue("cn"))
				}
			}
		}
	}
	return ExternalIdentity{
		Provider: "ldap", Subject: entry.DN, Email: entry.GetAttributeValue(cfg.EmailAttr),
		EmailVerified: true, DisplayName: name, Groups: groups,
	}, nil
}

// groupNames turns memberOf DNs ("cn=erp-admins,ou=groups,dc=x") into CNs.
func groupNames(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		dn, err := ldap.ParseDN(v)
		if err != nil || len(dn.RDNs) == 0 || len(dn.RDNs[0].Attributes) == 0 {
			out = append(out, v)
			continue
		}
		out = append(out, dn.RDNs[0].Attributes[0].Value)
	}
	return out
}
