package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

type SettingsStore interface {
	Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error)
	Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error
}

// Store reads/writes auth.methods, sealing secrets at rest.
type Store struct {
	settings SettingsStore
	box      *SecretBox
}

func NewStore(s SettingsStore, box *SecretBox) *Store { return &Store{settings: s, box: box} }

var errUnreadable = errors.New("providers: unreadable stored settings")

// Load returns the setting with secrets opened. A secret that can't be
// opened (master_key changed) reads as empty — the admin re-enters it.
func (s *Store) Load(ctx context.Context, tenant uuid.UUID) (Methods, error) {
	raw, ok, err := s.settings.Get(ctx, tenant, uuid.Nil, SettingsKey)
	if err != nil {
		return Methods{}, err
	}
	var m Methods
	if ok && raw != "" {
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			return Methods{}, fmt.Errorf("%w: %s: %v", errUnreadable, SettingsKey, err)
		}
	}
	if m.LDAP != nil {
		m.LDAP.BindPassword = s.open(m.LDAP.BindPassword)
	}
	for i := range m.OIDC {
		m.OIDC[i].ClientSecret = s.open(m.OIDC[i].ClientSecret)
	}
	return m, nil
}

func (s *Store) open(sealed string) string {
	if sealed == "" {
		return ""
	}
	plain, err := s.box.Open(sealed)
	if err != nil {
		return ""
	}
	return plain
}

// Save stores m. An empty secret keeps the stored one only while its
// destination (LDAP url+bind_dn, OIDC issuer) is unchanged — otherwise an
// editor could redirect the stored credential to a server they control — and
// an unreadable previous value is treated as empty so it can be overwritten.
func (s *Store) Save(ctx context.Context, tenant uuid.UUID, m Methods) error {
	prev, err := s.Load(ctx, tenant)
	if errors.Is(err, errUnreadable) {
		prev, err = Methods{}, nil
	}
	if err != nil {
		return err
	}
	if m.LDAP != nil {
		if m.LDAP.BindPassword == "" && prev.LDAP != nil && prev.LDAP.BindPassword != "" {
			if prev.LDAP.URL != m.LDAP.URL || prev.LDAP.BindDN != m.LDAP.BindDN {
				return invalid("re-enter the bind password when changing the LDAP server or bind DN")
			}
			m.LDAP.BindPassword = prev.LDAP.BindPassword
		}
		if m.LDAP.BindPassword, err = s.seal(m.LDAP.BindPassword); err != nil {
			return err
		}
	}
	for i := range m.OIDC {
		if m.OIDC[i].ClientSecret == "" {
			if p, ok := prev.Provider(m.OIDC[i].ID); ok && p.ClientSecret != "" {
				if p.Issuer != m.OIDC[i].Issuer {
					return invalid("re-enter the client secret when changing the issuer of %q", m.OIDC[i].ID)
				}
				m.OIDC[i].ClientSecret = p.ClientSecret
			}
		}
		if m.OIDC[i].ClientSecret, err = s.seal(m.OIDC[i].ClientSecret); err != nil {
			return err
		}
	}
	raw, _ := json.Marshal(m)
	return s.settings.Set(ctx, tenant, uuid.Nil, SettingsKey, string(raw))
}

func (s *Store) seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	return s.box.Seal(plain)
}
