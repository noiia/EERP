# External Authentication (LDAP / OIDC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ERP staff can sign in with local password, LDAP/LLDAP, or any number of OIDC providers; an admin picks the default method (top of the login screen) and the alternatives shown below it.

**Architecture:** New Go package `core/internal/auth/providers`: each method authenticates and returns an `ExternalIdentity`; one `Provisioner` links/creates the ERP user and re-applies group → role mapping; the existing session issuance ends every login. Settings live in `app_settings` key `auth.methods` with secrets AES-GCM-encrypted under `master_key`. The Next BFF owns cookies (LDAP relay, OIDC start/callback with PKCE state in an httpOnly cookie); the login page is rebuilt around a public `/auth/methods` endpoint.

**Tech Stack:** Go 1.27.1, echo v5, pgx, `github.com/go-ldap/ldap/v3`, `github.com/coreos/go-oidc/v3`, `golang.org/x/oauth2`, `golang.org/x/crypto/hkdf`; Next 16 / React 19 / MUI, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-external-auth-design.md`

**Spec amendment (made while planning):** the BFF never sends `redirect_uri`. Go builds it from the `erp_url` setting (`<erp_url>/api/auth/oidc/callback`) for both authorize and exchange, so the browser-facing code never needs to know the ERP origin and a forged Host header can't influence it. Role mapping stores **role ids** (stable when a role is renamed), not names.

## Global Constraints

- ERP users have `users.kind = ''` (empty string); website visitors `kind = 'website'` and are never touched by these flows.
- Settings key `auth.methods`, stored in the auth tenant's site-wide slot (`company_id = uuid.Nil`); the auth tenant is resolved like the website tenant (`website.ResolveTenant(ctx, db, cfg.WebsiteTenantID)`). With no resolvable tenant, only local login exists.
- Method ids: `local`, `ldap`, `oidc:<id>` where `<id>` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, unique.
- Secrets (`ldap.bind_password`, each provider `client_secret`) are write-only: GET returns `has_bind_password` / `has_client_secret`; a PUT with an empty secret keeps the stored one. Stored as `v1:<base64(nonce||ciphertext)>`, AES-256-GCM, key = HKDF-SHA256(master_key, info `eerp/auth-secrets`).
- Every external login failure (bad credentials, unlinkable, no role, disabled) answers **401 `{"error":{"code":"UNAUTHENTICATED","message":"Invalid username or password."}}`** for LDAP and **401 "Sign-in failed."** for OIDC — never the reason.
- An unverified OIDC email never links to an existing account; a soft-deleted (disabled) ERP user is never logged in nor re-created; a `(provider, subject)` already linked is never relinked.
- Role sync: provider-managed users' roles become exactly the mapped roles (or `default_role`); none → refused.
- Plain `ldap://` without StartTLS is refused unless the host is loopback.
- OIDC: Authorization Code + PKCE S256, `nonce` checked, ID token verified (signature via JWKS, `iss`, `aud`, `exp`).
- New auth routes use the existing auth rate limiter (`ormserver.AuthRateLimiter(configContent.AuthRateLimitPerMinute)`).
- `/app/login?method=local` always shows the local form.
- No LDAP container in compose. Real-LDAP tests run only when `LDAP_TEST_URL` is set.
- Go: `export PATH=$PATH:/usr/local/go/bin`; DB tests need `CONFIG=/home/noia/development/EERP/eerp-config.json`; tests on the dev DB use a fresh `uuid.New()` tenant and clean only their rows. Frontend: `npx -y pnpm@12.4.2`; rebuild the engine before shell tests when engine exports change; BFF route tests use `// @vitest-environment node`.
- Commits: `<type>(scope): <description>` + blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; identity `git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com`; stage only touched files; search with `rg`.

## Review Focus

1. **A broken IdP / directory config must not lock admins out** — `/app/login?method=local` still renders and local login still works when settings are invalid or `/auth/methods` errors. Pinned in Tasks 6 and 8.
2. **Account takeover by email** — an OIDC identity with `email_verified=false` matching an existing ERP user's email must be refused (not linked, not created). Pinned in Task 2.
3. **A disabled ERP user** (soft-deleted) must stay refused through LDAP/OIDC, including when no link exists yet and the email matches. Pinned in Task 2.
4. **OIDC state replay / CSRF** — a callback whose `state` doesn't match the cookie, or without a cookie, must not log anyone in. Pinned in Task 7.
5. **LDAP empty password** — an empty password must never reach a bind (anonymous-bind success). Pinned in Task 4.

---

### Task 1: Secret box and auth settings model

**Files:**
- Create: `core/internal/auth/providers/secret.go`, `core/internal/auth/providers/secret_test.go`
- Create: `core/internal/auth/providers/settings.go`, `core/internal/auth/providers/settings_test.go`

**Interfaces:**
- Produces:
  - `type SecretBox struct{...}`; `func NewSecretBox(masterKey string) (*SecretBox, error)`; `func (b *SecretBox) Seal(plain string) (string, error)`; `func (b *SecretBox) Open(sealed string) (string, error)`; `var ErrSecret`.
  - Types `Methods`, `LDAPConfig`, `OIDCProvider`, `RoleMapping` (below), `const SettingsKey = "auth.methods"`.
  - `func (m Methods) Validate(roleExists func(uuid.UUID) bool) error` (errors wrap `ErrInvalidSettings`).
  - `func (m Methods) Public() PublicMethods`; `type PublicMethods struct{ Default PublicMethod; Alternatives []PublicMethod }`; `type PublicMethod struct{ ID, Kind, Label string }` (Kind `password` | `redirect`).
  - `func (m Methods) Provider(id string) (OIDCProvider, bool)`.
  - `func LLDAPDefaults(baseDN string) LDAPConfig`.
  - `func (m Methods) CallbackURL() string` → `strings.TrimRight(m.ERPURL, "/") + "/api/auth/oidc/callback"`.

- [ ] **Step 1: Failing tests**

```go
// core/internal/auth/providers/secret_test.go
package providers

import (
	"errors"
	"strings"
	"testing"
)

func TestSecretBox(t *testing.T) {
	b, err := NewSecretBox("master-key-for-tests")
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := b.Seal("s3cret")
	if err != nil || !strings.HasPrefix(sealed, "v1:") || strings.Contains(sealed, "s3cret") {
		t.Fatalf("seal = %q, %v", sealed, err)
	}
	again, _ := b.Seal("s3cret")
	if again == sealed {
		t.Error("two seals of the same secret must differ (random nonce)")
	}
	if plain, err := b.Open(sealed); err != nil || plain != "s3cret" {
		t.Fatalf("open = %q, %v", plain, err)
	}
	other, _ := NewSecretBox("another-master-key")
	if _, err := other.Open(sealed); !errors.Is(err, ErrSecret) {
		t.Errorf("other key: err = %v, want ErrSecret", err)
	}
	for _, bad := range []string{"", "s3cret", "v1:!!", "v1:" + strings.Repeat("A", 8)} {
		if _, err := b.Open(bad); !errors.Is(err, ErrSecret) {
			t.Errorf("Open(%q) err = %v", bad, err)
		}
	}
	if _, err := NewSecretBox(""); err == nil {
		t.Error("empty master key must be refused")
	}
}
```

```go
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd core && go test ./internal/auth/providers/`
Expected: FAIL — package has no Go files.

- [ ] **Step 3: Implement `secret.go`**

```go
// Package providers implements external ERP sign-in (ADR-030): LDAP and OIDC
// authenticate a person and return an ExternalIdentity; Provisioner links or
// creates the ERP user and syncs its roles; the auth handler issues the
// session. Settings live in app_settings "auth.methods".
package providers

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/hkdf"
)

// ErrSecret: a sealed secret can't be opened (wrong master_key, corrupt value).
var ErrSecret = errors.New("providers: cannot open secret")

const sealedPrefix = "v1:"

// SecretBox encrypts provider secrets at rest with a key derived from
// master_key, so an app_settings dump never reveals a bind password or
// client secret. Changing master_key makes stored secrets unreadable.
type SecretBox struct{ aead cipher.AEAD }

func NewSecretBox(masterKey string) (*SecretBox, error) {
	if masterKey == "" {
		return nil, errors.New("providers: empty master key")
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, []byte(masterKey), nil, []byte("eerp/auth-secrets")), key); err != nil {
		return nil, fmt.Errorf("providers: derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretBox{aead: aead}, nil
}

func (b *SecretBox) Seal(plain string) (string, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, []byte(plain), nil)
	return sealedPrefix + base64.StdEncoding.EncodeToString(out), nil
}

func (b *SecretBox) Open(sealed string) (string, error) {
	raw, ok := strings.CutPrefix(sealed, sealedPrefix)
	if !ok {
		return "", ErrSecret
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(data) < b.aead.NonceSize() {
		return "", ErrSecret
	}
	plain, err := b.aead.Open(nil, data[:b.aead.NonceSize()], data[b.aead.NonceSize():], nil)
	if err != nil {
		return "", ErrSecret
	}
	return string(plain), nil
}
```

- [ ] **Step 4: Implement `settings.go`**

```go
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
	if id == "local" || id == m.defaultID() {
		return true
	}
	for _, e := range m.Enabled {
		if e == id {
			return true
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
		if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname()))) || u.Host == "" {
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
```

- [ ] **Step 5: Run the tests**

Run: `cd core && go test ./internal/auth/providers/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add core/internal/auth/providers core/go.mod core/go.sum
rtk git commit -m "feat(auth): auth methods settings model and secret box"
```

---

### Task 2: Identity links and the provisioning pipeline

**Files:**
- Create: `core/internal/auth/providers/identity.go` (model + `ExternalIdentity`), `core/internal/auth/providers/provision.go`, `core/internal/auth/providers/provision_test.go`
- Modify: `core/modules/auth/module.go` (register `AuthIdentity` excluded; unique index in `Migrate`)

**Interfaces:**
- Consumes: `Methods`, `RoleMapping` (Task 1).
- Produces:
  - `type ExternalIdentity struct{ Provider, Subject, Email string; EmailVerified bool; DisplayName string; Groups []string }`.
  - `type AuthIdentity struct{ model.BaseModel; UserID uuid.UUID \`db:"user_id"\`; Provider string \`db:"provider"\`; Subject string \`db:"subject"\` }` — table `auth_identity`.
  - `type Provisioner struct{ db *orm.DB }`; `func NewProvisioner(db *orm.DB) *Provisioner`; `func (p *Provisioner) Provision(ctx context.Context, tenant uuid.UUID, id ExternalIdentity, m Methods) (uuid.UUID, error)`; `var ErrRefused`.

- [ ] **Step 1: Failing DB-backed test**

```go
// core/internal/auth/providers/provision_test.go
package providers_test

import (
	"context"
	"errors"
	"testing"

	_ "core/modules/auth"

	"core/internal/auth/providers"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

type fixture struct {
	t      *testing.T
	db     *orm.DB
	tenant uuid.UUID
	admin  uuid.UUID // role id
	staff  uuid.UUID
}

func newFixture(t *testing.T) *fixture {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth")
	f := &fixture{t: t, db: app.DB, tenant: uuid.New()}
	ctx := context.Background()
	for _, r := range []struct {
		name string
		id   *uuid.UUID
	}{{"ext-admin", &f.admin}, {"ext-staff", &f.staff}} {
		*r.id = uuid.New()
		if _, err := f.db.Exec(ctx, `INSERT INTO roles (id, tenant_id, name, description) VALUES ($1, $2, $3, '')`, *r.id, f.tenant, r.name+"-"+f.tenant.String()[:8]); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM auth_identity WHERE tenant_id = $1`,
			`DELETE FROM user_roles WHERE tenant_id = $1`,
			`DELETE FROM users WHERE tenant_id = $1`,
			`DELETE FROM roles WHERE tenant_id = $1`,
		} {
			_, _ = f.db.Exec(ctx, q, f.tenant)
		}
	})
	return f
}

func (f *fixture) user(email string, deleted bool) uuid.UUID {
	id := uuid.New()
	q := `INSERT INTO users (id, tenant_id, email, password_hash, kind) VALUES ($1, $2, $3, 'x', '')`
	if deleted {
		q = `INSERT INTO users (id, tenant_id, email, password_hash, kind, deleted_at) VALUES ($1, $2, $3, 'x', '', now())`
	}
	if _, err := f.db.Exec(context.Background(), q, id, f.tenant, email); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *fixture) roles(user uuid.UUID) map[uuid.UUID]bool {
	rows, err := f.db.Query(context.Background(), `SELECT role_id FROM user_roles WHERE user_id = $1 AND deleted_at IS NULL`, user)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	out := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		_ = rows.Scan(&id)
		out[id] = true
	}
	return out
}

func (f *fixture) methods() providers.Methods {
	return providers.Methods{RoleMapping: []providers.RoleMapping{
		{Group: "erp-admins", RoleID: f.admin}, {Group: "erp-staff", RoleID: f.staff},
	}}
}

func TestProvision(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	m := f.methods()
	email := func() string { return uuid.NewString()[:8] + "@ext.test" }

	t.Run("creates and links a new user with mapped roles", func(t *testing.T) {
		e := email()
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=a," + e, Email: e, EmailVerified: true, DisplayName: "A", Groups: []string{"erp-staff"},
		}, m)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.staff] {
			t.Errorf("roles = %v", got)
		}
		again, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=a," + e, Email: "changed-" + e, EmailVerified: true, Groups: []string{"erp-admins"},
		}, m)
		if err != nil || again != id {
			t.Fatalf("second login = %v, %v; want the same user", again, err)
		}
		if got := f.roles(id); len(got) != 1 || !got[f.admin] {
			t.Errorf("roles after regroup = %v, want exactly admin", got)
		}
	})

	t.Run("links an existing user by verified email", func(t *testing.T) {
		e := email()
		existing := f.user(e, false)
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "sub-1-" + e, Email: strings.ToUpper(e), EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if err != nil || id != existing {
			t.Fatalf("got %v, %v; want existing %v", id, err, existing)
		}
	})

	t.Run("an unverified email never links nor creates (Review Focus 2)", func(t *testing.T) {
		e := email()
		f.user(e, false)
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "sub-2-" + e, Email: e, EmailVerified: false, Groups: []string{"erp-admins"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})

	t.Run("a disabled user stays refused (Review Focus 3)", func(t *testing.T) {
		e := email()
		f.user(e, true)
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=d," + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})

	t.Run("no mapped group and no default role is refused", func(t *testing.T) {
		e := email()
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=n," + e, Email: e, EmailVerified: true, Groups: []string{"other"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
		withDefault := m
		withDefault.DefaultRoleID = &f.staff
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=n," + e, Email: e, EmailVerified: true, Groups: []string{"other"},
		}, withDefault)
		if err != nil || !f.roles(id)[f.staff] {
			t.Fatalf("default role: %v, %v", id, err)
		}
	})

	t.Run("an email already linked to another subject of the provider is refused", func(t *testing.T) {
		e := email()
		if _, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "first-" + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m); err != nil {
			t.Fatal(err)
		}
		_, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "oidc:corp", Subject: "second-" + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})

	t.Run("a link to a since-disabled user is refused", func(t *testing.T) {
		e := email()
		id, err := providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=x," + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.db.Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, id)
		_, err = providers.NewProvisioner(f.db).Provision(ctx, f.tenant, providers.ExternalIdentity{
			Provider: "ldap", Subject: "uid=x," + e, Email: e, EmailVerified: true, Groups: []string{"erp-staff"},
		}, m)
		if !errors.Is(err, providers.ErrRefused) {
			t.Fatalf("err = %v, want ErrRefused", err)
		}
	})
}
```

(`strings.ToUpper(e)` asserts case-insensitive email matching — add `"strings"` to the imports.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -timeout 120s ./internal/auth/providers/`
Expected: FAIL — undefined `providers.NewProvisioner`.

- [ ] **Step 3: Implement**

`identity.go`:

```go
package providers

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// ExternalIdentity is what an external method proved about a person.
type ExternalIdentity struct {
	Provider      string // "ldap" or "oidc:<provider id>"
	Subject       string // stable id at the provider (LDAP entry DN, OIDC sub)
	Email         string
	EmailVerified bool
	DisplayName   string
	Groups        []string
}

// AuthIdentity links an ERP user to a (provider, subject). Off the generic
// CRUD surface; unique (tenant_id, provider, subject) hand-written in the
// auth module's Migrate.
type AuthIdentity struct {
	model.BaseModel
	UserID   uuid.UUID `db:"user_id"`
	Provider string    `db:"provider"`
	Subject  string    `db:"subject"`
}
```

`provision.go`:

```go
package providers

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

// ErrRefused: the identity can't be signed in (unlinkable, disabled, no role).
// Callers answer the same generic 401 as a bad password.
var ErrRefused = errors.New("providers: sign-in refused")

type Provisioner struct{ db *orm.DB }

func NewProvisioner(db *orm.DB) *Provisioner { return &Provisioner{db: db} }

// Provision resolves the ERP user for id in tenant — linked identity, else
// (verified email only) the live ERP user with that email, else a new one —
// then makes its roles exactly the mapped roles. All in one transaction.
func (p *Provisioner) Provision(ctx context.Context, tenant uuid.UUID, id ExternalIdentity, m Methods) (uuid.UUID, error) {
	roles := mappedRoles(id.Groups, m)
	if len(roles) == 0 || id.Subject == "" {
		return uuid.Nil, ErrRefused
	}
	var userID uuid.UUID
	err := orm.Transact(ctx, p.db, func(tx *orm.Tx) error {
		var err error
		userID, err = resolveUser(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		return syncRoles(ctx, tx, tenant, userID, roles)
	})
	return userID, err
}

func mappedRoles(groups []string, m Methods) []uuid.UUID {
	set := map[uuid.UUID]bool{}
	for _, g := range groups {
		for _, rm := range m.RoleMapping {
			if strings.EqualFold(strings.TrimSpace(g), strings.TrimSpace(rm.Group)) {
				set[rm.RoleID] = true
			}
		}
	}
	if len(set) == 0 && m.DefaultRoleID != nil {
		set[*m.DefaultRoleID] = true
	}
	out := make([]uuid.UUID, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	return out
}

func resolveUser(ctx context.Context, tx *orm.Tx, tenant uuid.UUID, id ExternalIdentity) (uuid.UUID, error) {
	// 1. Linked identity.
	var linked uuid.UUID
	var deleted bool
	err := tx.QueryRow(ctx, `
		SELECT u.id, u.deleted_at IS NOT NULL FROM auth_identity a JOIN users u ON u.id = a.user_id
		WHERE a.tenant_id = $1 AND a.provider = $2 AND a.subject = $3 AND a.deleted_at IS NULL`,
		tenant, id.Provider, id.Subject).Scan(&linked, &deleted)
	switch {
	case err == nil:
		if deleted {
			return uuid.Nil, ErrRefused
		}
		return linked, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, fmt.Errorf("provision: find link: %w", err)
	}

	email := strings.ToLower(strings.TrimSpace(id.Email))
	if email == "" {
		return uuid.Nil, ErrRefused
	}
	// 2. Any ERP user (live or disabled) with that email.
	var existing uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT id, deleted_at IS NOT NULL FROM users
		WHERE tenant_id = $1 AND kind = '' AND lower(email) = $2
		ORDER BY deleted_at NULLS FIRST LIMIT 1`, tenant, email).Scan(&existing, &deleted)
	switch {
	case err == nil:
		if deleted || !id.EmailVerified {
			return uuid.Nil, ErrRefused
		}
		var other int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM auth_identity WHERE tenant_id = $1 AND provider = $2 AND user_id = $3 AND deleted_at IS NULL`,
			tenant, id.Provider, existing).Scan(&other); err != nil {
			return uuid.Nil, fmt.Errorf("provision: check link: %w", err)
		}
		if other > 0 {
			return uuid.Nil, ErrRefused // linked to another subject of this provider
		}
		return existing, link(ctx, tx, tenant, existing, id)
	case !errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, fmt.Errorf("provision: find by email: %w", err)
	}

	// 3. Create (locked local password: random, discarded).
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return uuid.Nil, err
	}
	hash, err := bcrypt.GenerateFromPassword(raw, bcrypt.DefaultCost)
	if err != nil {
		return uuid.Nil, err
	}
	created := uuid.New()
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, tenant_id, email, password_hash, display_name, kind)
		VALUES ($1, $2, $3, $4, $5, '')`, created, tenant, email, string(hash), id.DisplayName); err != nil {
		return uuid.Nil, fmt.Errorf("provision: create user: %w", err)
	}
	return created, link(ctx, tx, tenant, created, id)
}

func link(ctx context.Context, tx *orm.Tx, tenant, user uuid.UUID, id ExternalIdentity) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_identity (id, tenant_id, user_id, provider, subject) VALUES ($1, $2, $3, $4, $5)`,
		uuid.New(), tenant, user, id.Provider, id.Subject); err != nil {
		return fmt.Errorf("provision: link: %w", err)
	}
	return nil
}

func syncRoles(ctx context.Context, tx *orm.Tx, tenant, user uuid.UUID, roles []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE user_roles SET deleted_at = now(), updated_at = now()
		WHERE user_id = $1 AND deleted_at IS NULL AND NOT (role_id = ANY($2))`, user, roles); err != nil {
		return fmt.Errorf("provision: drop roles: %w", err)
	}
	for _, r := range roles {
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_roles (id, tenant_id, user_id, role_id) VALUES ($1, $2, $3, $4)
			ON CONFLICT (user_id, role_id) WHERE deleted_at IS NULL DO NOTHING`, uuid.New(), tenant, user, r); err != nil {
			return fmt.Errorf("provision: add role: %w", err)
		}
	}
	return nil
}
```

`core/modules/auth/module.go`: in `Register()`, add `orm.Register[providers.AuthIdentity](orm.WithTableName("auth_identity"), orm.WithExcluded())`; in `Migrate`, add:

```go
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identity_subject
		ON auth_identity (tenant_id, provider, subject) WHERE deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("auth: create auth_identity unique index: %w", err)
	}
```

- [ ] **Step 4: Run the tests**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -timeout 300s ./internal/auth/... ./modules/auth/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/auth/providers core/modules/auth/module.go
rtk git commit -m "feat(auth): identity links and external sign-in provisioning"
```

---

### Task 3: Settings store, settings API and public methods

**Files:**
- Create: `core/internal/auth/providers/store.go`, `core/internal/auth/providers/handler.go` (settings + public part), `core/internal/auth/providers/handler_test.go`

**Interfaces:**
- Consumes: `Methods`, `SecretBox` (Task 1).
- Produces:
  - `type SettingsStore interface{ Get(ctx, tenant, company uuid.UUID, key string) (string, bool, error); Set(ctx, tenant, company uuid.UUID, key, value string) error }` (satisfied by `*settings.Repository`).
  - `type Store struct{ settings SettingsStore; box *SecretBox }`; `func NewStore(s SettingsStore, box *SecretBox) *Store`; `func (s *Store) Load(ctx, tenant) (Methods, error)` (secrets opened; an unopenable secret becomes `""`); `func (s *Store) Save(ctx, tenant, m Methods) error` (secrets sealed; empty secret keeps the stored one).
  - `type Handler struct{...}`; `func NewHandler(deps Deps) *Handler`; `type Deps struct{ Store *Store; Tenant uuid.UUID; Roles func(ctx context.Context, tenant uuid.UUID) (map[uuid.UUID]bool, error); Directory Directory; OIDC *OIDCClient; Provisioner *Provisioner; Sessions SessionIssuer }` (Directory / OIDCClient / SessionIssuer defined in Tasks 4–5; declare them here as interfaces/placeholders only if needed to compile — prefer adding the fields in the task that defines them).
  - Routes: `GetSettings` (`GET /api/v1/settings/auth`), `PutSettings` (`PUT`), `PublicMethods` (`GET /api/v1/auth/methods`).

- [ ] **Step 1: Failing tests** — `handler_test.go` with an in-memory `SettingsStore` (map) and a fake roles func:

```go
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
```

- [ ] **Step 2: Run to verify it fails** — `cd core && go test ./internal/auth/providers/` → FAIL (undefined `NewHandler`).

- [ ] **Step 3: Implement**

`store.go`:

```go
package providers

import (
	"context"
	"encoding/json"
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
			return Methods{}, fmt.Errorf("providers: unreadable %s: %w", SettingsKey, err)
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

// Save stores m; an empty secret keeps the currently stored one.
func (s *Store) Save(ctx context.Context, tenant uuid.UUID, m Methods) error {
	prev, err := s.Load(ctx, tenant)
	if err != nil {
		return err
	}
	if m.LDAP != nil {
		if m.LDAP.BindPassword == "" && prev.LDAP != nil {
			m.LDAP.BindPassword = prev.LDAP.BindPassword
		}
		if m.LDAP.BindPassword, err = s.seal(m.LDAP.BindPassword); err != nil {
			return err
		}
	}
	for i := range m.OIDC {
		if m.OIDC[i].ClientSecret == "" {
			if p, ok := prev.Provider(m.OIDC[i].ID); ok {
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
```

`handler.go` (settings + public part; Tasks 4–5 add login routes and Deps fields):

```go
package providers

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type Deps struct {
	Store  *Store
	Tenant uuid.UUID // auth tenant; uuid.Nil = only local login exists
	// Roles lists the tenant's role ids (validation of the mapping).
	Roles func(ctx context.Context, tenant uuid.UUID) (map[uuid.UUID]bool, error)
}

type Handler struct{ deps Deps }

func NewHandler(deps Deps) *Handler { return &Handler{deps: deps} }

// settingsView is the GET shape: secrets replaced by has_* flags.
type settingsView struct {
	Methods
	LDAP        *ldapView    `json:"ldap,omitempty"`
	OIDC        []oidcView   `json:"oidc"`
	CallbackURL string       `json:"callback_url"`
}

type ldapView struct {
	LDAPConfig
	BindPassword    string `json:"bind_password,omitempty"` // always "" — shadows the embedded field
	HasBindPassword bool   `json:"has_bind_password"`
}

type oidcView struct {
	OIDCProvider
	ClientSecret    string `json:"client_secret,omitempty"`
	HasClientSecret bool   `json:"has_client_secret"`
}

// GetSettings handles GET /api/v1/settings/auth (settings:auth:read).
func (h *Handler) GetSettings(c *echo.Context) error {
	m, err := h.deps.Store.Load(c.Request().Context(), h.deps.Tenant)
	if err != nil {
		return err
	}
	v := settingsView{Methods: m, OIDC: []oidcView{}, CallbackURL: m.CallbackURL()}
	if m.LDAP != nil {
		v.LDAP = &ldapView{LDAPConfig: *m.LDAP, HasBindPassword: m.LDAP.BindPassword != ""}
	}
	for _, p := range m.OIDC {
		v.OIDC = append(v.OIDC, oidcView{OIDCProvider: p, HasClientSecret: p.ClientSecret != ""})
	}
	return c.JSON(http.StatusOK, v)
}

// PutSettings handles PUT /api/v1/settings/auth (settings:auth:write).
func (h *Handler) PutSettings(c *echo.Context) error {
	if h.deps.Tenant == uuid.Nil {
		return echo.NewHTTPError(http.StatusConflict, "external sign-in needs a single workspace tenant (website_tenant_id)")
	}
	var m Methods
	if err := c.Bind(&m); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	ctx := c.Request().Context()
	roles, err := h.deps.Roles(ctx, h.deps.Tenant)
	if err != nil {
		return err
	}
	if err := m.Validate(func(id uuid.UUID) bool { return roles[id] }); err != nil {
		if errors.Is(err, ErrInvalidSettings) {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		return err
	}
	if err := h.deps.Store.Save(ctx, h.deps.Tenant, m); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// PublicMethods handles GET /api/v1/auth/methods (anonymous): what the login
// screen shows. Any failure degrades to local only — never a lockout.
func (h *Handler) PublicMethods(c *echo.Context) error {
	m := Methods{}
	if h.deps.Tenant != uuid.Nil {
		if loaded, err := h.deps.Store.Load(c.Request().Context(), h.deps.Tenant); err == nil {
			m = loaded
		}
	}
	return c.JSON(http.StatusOK, m.Public())
}
```

(`settingsView` embeds `Methods` and shadows its `LDAP`/`OIDC` fields; check with the test that the JSON has a single `ldap` / `oidc` key — Go's encoding/json picks the shallower field.)

- [ ] **Step 4: Run** — `cd core && go test ./internal/auth/providers/` → PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/auth/providers
rtk git commit -m "feat(auth): auth methods settings API and public login methods"
```

---

### Task 4: LDAP sign-in

**Files:**
- Create: `core/internal/auth/providers/ldap.go`, `core/internal/auth/providers/ldap_test.go`, `core/internal/auth/providers/ldap_live_test.go`
- Modify: `core/internal/auth/providers/handler.go` (Deps fields + `LDAPLogin`, `TestSettings` LDAP branch)
- Modify: `core/go.mod` (`go get github.com/go-ldap/ldap/v3`)

**Interfaces:**
- Produces:
  - `type Directory interface{ Authenticate(ctx context.Context, cfg LDAPConfig, username, password string) (ExternalIdentity, error); Check(ctx context.Context, cfg LDAPConfig) error }`; `var ErrInvalidCredentials`.
  - `type LDAPDirectory struct{ Timeout time.Duration }` implementing it with go-ldap.
  - `type SessionIssuer interface{ IssueSessionForUser(c *echo.Context, userID uuid.UUID) error }` (implemented by `*auth.Handler` in Task 6).
  - `Deps` gains `Directory Directory`, `Provisioner *Provisioner`, `Sessions SessionIssuer`.
  - `func (h *Handler) LDAPLogin(c *echo.Context) error` — `POST /api/v1/auth/ldap/login {username, password}`.
  - `func (h *Handler) TestSettings(c *echo.Context) error` — `POST /api/v1/settings/auth/test {method}` → `{ok, message}` (LDAP: `Directory.Check`; OIDC branch added in Task 5).

- [ ] **Step 1: Failing tests** — `ldap_test.go`:

```go
package providers

import (
	"context"
	"net/http"
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
	calls int
}

func (f *fakeDirectory) Authenticate(_ context.Context, _ LDAPConfig, username, password string) (ExternalIdentity, error) {
	f.calls++
	u, ok := f.users[username]
	if !ok || u.password != password {
		return ExternalIdentity{}, ErrInvalidCredentials
	}
	return u.id, nil
}
func (f *fakeDirectory) Check(context.Context, LDAPConfig) error { return nil }

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

func TestLDAPLogin(t *testing.T) {
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

	if rec := call(t, h.LDAPLogin, http.MethodPost, `{"username":"alice","password":"pw"}`); rec.Code != http.StatusOK || sessions.issued != user {
		t.Fatalf("good login = %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{
		`{"username":"alice","password":"nope"}`,
		`{"username":"bob","password":"pw"}`,
	} {
		rec := call(t, h.LDAPLogin, http.MethodPost, body)
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "Invalid username or password.") {
			t.Errorf("%s = %d %s", body, rec.Code, rec.Body.String())
		}
	}
	before := dir.calls
	if rec := call(t, h.LDAPLogin, http.MethodPost, `{"username":"alice","password":""}`); rec.Code != http.StatusUnauthorized || dir.calls != before {
		t.Errorf("empty password must be refused before any bind (Review Focus 5): %d, calls %d→%d", rec.Code, before, dir.calls)
	}
	// LDAP not offered on the login screen → 401 (not configured as a method).
	_ = h.deps.Store.Save(context.Background(), h.deps.Tenant, Methods{Default: "local", LDAP: &ldap})
	if rec := call(t, h.LDAPLogin, http.MethodPost, `{"username":"alice","password":"pw"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("disabled ldap = %d", rec.Code)
	}
}
```

(The handler exposes an unexported `provision func(ctx, tenant, ExternalIdentity, Methods) (uuid.UUID, error)` field defaulting to `deps.Provisioner.Provision`, so handler tests don't need a DB.)

`ldap_live_test.go` — runs only with `LDAP_TEST_URL`, `LDAP_TEST_BIND_DN`, `LDAP_TEST_BIND_PASSWORD`, `LDAP_TEST_BASE_DN`, `LDAP_TEST_USER`, `LDAP_TEST_PASSWORD`:

```go
package providers

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestLDAPDirectoryLive(t *testing.T) {
	url := os.Getenv("LDAP_TEST_URL")
	if url == "" {
		t.Skip("LDAP_TEST_URL not set")
	}
	cfg := LLDAPDefaults(os.Getenv("LDAP_TEST_BASE_DN"))
	cfg.URL, cfg.BindDN, cfg.BindPassword = url, os.Getenv("LDAP_TEST_BIND_DN"), os.Getenv("LDAP_TEST_BIND_PASSWORD")
	d := LDAPDirectory{Timeout: 5 * time.Second}
	ctx := context.Background()
	if err := d.Check(ctx, cfg); err != nil {
		t.Fatalf("check: %v", err)
	}
	id, err := d.Authenticate(ctx, cfg, os.Getenv("LDAP_TEST_USER"), os.Getenv("LDAP_TEST_PASSWORD"))
	if err != nil || id.Subject == "" || id.Email == "" {
		t.Fatalf("authenticate = %+v, %v", id, err)
	}
	if _, err := d.Authenticate(ctx, cfg, os.Getenv("LDAP_TEST_USER"), "definitely-wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password err = %v", err)
	}
}
```

- [ ] **Step 2: Run to verify failure** — `cd core && go get github.com/go-ldap/ldap/v3 && go test ./internal/auth/providers/` → FAIL (undefined `ErrInvalidCredentials`, `userFilter`, `LDAPLogin`).

- [ ] **Step 3: Implement `ldap.go`**

```go
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
	attrs := []string{"dn", cfg.EmailAttr, cfg.NameAttr, "displayName"}
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
```

`handler.go` additions:

```go
type SessionIssuer interface {
	IssueSessionForUser(c *echo.Context, userID uuid.UUID) error
}

// Deps gains:
//   Directory   Directory
//   Provisioner *Provisioner
//   Sessions    SessionIssuer
// and Handler gains `provision func(...)` set in NewHandler:
//   h := &Handler{deps: deps}
//   if deps.Provisioner != nil { h.provision = deps.Provisioner.Provision }

func unauthorized(c *echo.Context, message string) error {
	return c.JSON(http.StatusUnauthorized, map[string]any{"error": map[string]string{
		"code": "UNAUTHENTICATED", "message": message, "request_id": c.Response().Header().Get(echo.HeaderXRequestID),
	}})
}

// LDAPLogin handles POST /api/v1/auth/ldap/login {username, password}.
func (h *Handler) LDAPLogin(c *echo.Context) error {
	const msg = "Invalid username or password."
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.Bind(&req); err != nil || req.Username == "" || req.Password == "" {
		return unauthorized(c, msg)
	}
	ctx := c.Request().Context()
	if h.deps.Tenant == uuid.Nil {
		return unauthorized(c, msg)
	}
	m, err := h.deps.Store.Load(ctx, h.deps.Tenant)
	if err != nil {
		return err
	}
	if m.LDAP == nil || !m.Allows("ldap") {
		return unauthorized(c, msg)
	}
	id, err := h.deps.Directory.Authenticate(ctx, *m.LDAP, strings.TrimSpace(req.Username), req.Password)
	if err != nil {
		if errors.Is(err, ErrInvalidCredentials) {
			return unauthorized(c, msg)
		}
		return fmt.Errorf("ldap login: %w", err) // directory down: a 500, logged
	}
	userID, err := h.provision(ctx, h.deps.Tenant, id, m)
	if err != nil {
		if errors.Is(err, ErrRefused) {
			return unauthorized(c, msg)
		}
		return err
	}
	return h.deps.Sessions.IssueSessionForUser(c, userID)
}

// TestSettings handles POST /api/v1/settings/auth/test {method} (settings:auth:write).
func (h *Handler) TestSettings(c *echo.Context) error {
	var req struct {
		Method string `json:"method"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	ctx := c.Request().Context()
	m, err := h.deps.Store.Load(ctx, h.deps.Tenant)
	if err != nil {
		return err
	}
	var testErr error
	switch {
	case req.Method == "ldap" && m.LDAP != nil:
		testErr = h.deps.Directory.Check(ctx, *m.LDAP)
	default:
		return echo.NewHTTPError(http.StatusBadRequest, "unknown or unconfigured method")
	}
	if testErr != nil {
		return c.JSON(http.StatusOK, map[string]any{"ok": false, "message": testErr.Error()})
	}
	return c.JSON(http.StatusOK, map[string]any{"ok": true, "message": "Connection succeeded."})
}
```


- [ ] **Step 4: Run** — `cd core && go test ./internal/auth/providers/` → PASS (live test skipped).

- [ ] **Step 5: Commit**

```bash
rtk git add core/go.mod core/go.sum core/internal/auth/providers
rtk git commit -m "feat(auth): LDAP / LLDAP sign-in"
```

---

### Task 5: OIDC sign-in

**Files:**
- Create: `core/internal/auth/providers/oidc.go`, `core/internal/auth/providers/oidc_test.go`
- Modify: `core/internal/auth/providers/handler.go` (`OIDCAuthorize`, `OIDCExchange`, TestSettings OIDC branch)
- Modify: `core/go.mod` (`go get github.com/coreos/go-oidc/v3 golang.org/x/oauth2`)

**Interfaces:**
- Produces:
  - `type OIDCClient struct{...}`; `func NewOIDCClient(httpClient *http.Client) *OIDCClient`; `func (o *OIDCClient) AuthorizeURL(ctx, p OIDCProvider, redirectURI, state, nonce, challenge string) (string, error)`; `func (o *OIDCClient) Exchange(ctx, p OIDCProvider, code, verifier, redirectURI, nonce string) (ExternalIdentity, error)`; `func (o *OIDCClient) Check(ctx, p OIDCProvider) error`; `var ErrOIDC`.
  - `Deps` gains `OIDC *OIDCClient`.
  - `GET /api/v1/auth/oidc/providers/:id/authorize?state=&nonce=&code_challenge=` → `{url}` (404 unknown/not enabled provider; 400 missing params).
  - `POST /api/v1/auth/oidc/providers/:id/exchange {code, code_verifier, nonce}` → session or 401 "Sign-in failed.".

- [ ] **Step 1: Failing tests** — `oidc_test.go` runs a fake provider with `httptest.NewTLSServer`:

```go
package providers

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// fakeIdP is a minimal OIDC provider: discovery, JWKS, token endpoint.
type fakeIdP struct {
	srv      *httptest.Server
	key      *rsa.PrivateKey
	claims   map[string]any // ID token claims for the next code
	verifier string         // expected PKCE verifier
	wrongKey bool
}

func newFakeIdP(t *testing.T) *fakeIdP {
	f := &fakeIdP{}
	f.key, _ = rsa.GenerateKey(rand.Reader, 2048)
	mux := http.NewServeMux()
	f.srv = httptest.NewTLSServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize",
			"token_endpoint": f.srv.URL + "/token", "jwks_uri": f.srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &f.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if base64.RawURLEncoding.EncodeToString(sum[:]) != f.verifier {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		signKey := f.key
		if f.wrongKey {
			signKey, _ = rsa.GenerateKey(rand.Reader, 2048)
		}
		signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: signKey}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
		tok, _ := jwt.Signed(signer).Claims(f.claims).Serialize()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "id_token": tok})
	})
	t.Cleanup(f.srv.Close)
	return f
}

func pkce() (verifier, challenge string) {
	verifier = "verifier-" + strings.Repeat("x", 40)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func TestOIDCExchange(t *testing.T) {
	idp := newFakeIdP(t)
	client := NewOIDCClient(idp.srv.Client())
	p := OIDCProvider{ID: "corp", Issuer: idp.srv.URL, ClientID: "erp", ClientSecret: "s", GroupsClaim: "groups"}
	ctx := context.Background()
	verifier, challenge := pkce()

	url, err := client.AuthorizeURL(ctx, p, "https://erp/api/auth/oidc/callback", "st", "n1", challenge)
	if err != nil || !strings.Contains(url, "code_challenge="+challenge) || !strings.Contains(url, "code_challenge_method=S256") || !strings.Contains(url, "nonce=n1") {
		t.Fatalf("authorize url = %q, %v", url, err)
	}

	base := func() map[string]any {
		return map[string]any{"iss": idp.srv.URL, "aud": "erp", "sub": "u-1", "exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(), "nonce": "n1", "email": "a@x", "email_verified": true, "name": "A", "groups": []string{"erp"}}
	}
	idp.verifier = challenge

	idp.claims = base()
	id, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1")
	if err != nil || id.Subject != "u-1" || id.Provider != "oidc:corp" || !id.EmailVerified || len(id.Groups) != 1 {
		t.Fatalf("exchange = %+v, %v", id, err)
	}

	cases := map[string]func(map[string]any){
		"wrong audience": func(c map[string]any) { c["aud"] = "other" },
		"expired":        func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() },
		"wrong nonce":    func(c map[string]any) { c["nonce"] = "n2" },
		"wrong issuer":   func(c map[string]any) { c["iss"] = "https://evil" },
	}
	for name, mutate := range cases {
		c := base()
		mutate(c)
		idp.claims = c
		if _, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); !errors.Is(err, ErrOIDC) {
			t.Errorf("%s: err = %v, want ErrOIDC", name, err)
		}
	}
	idp.claims = base()
	idp.wrongKey = true
	if _, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); !errors.Is(err, ErrOIDC) {
		t.Errorf("bad signature: err = %v", err)
	}
	idp.wrongKey = false
	if _, err := client.Exchange(ctx, p, "code", "not-the-verifier", "https://erp/api/auth/oidc/callback", "n1"); !errors.Is(err, ErrOIDC) {
		t.Errorf("PKCE mismatch: err = %v", err)
	}
	c := base()
	c["email_verified"] = false
	idp.claims = c
	if id, err := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); err != nil || id.EmailVerified {
		t.Errorf("unverified email: %+v %v", id, err)
	}
	p.TrustEmail = true
	if id, _ := client.Exchange(ctx, p, "code", verifier, "https://erp/api/auth/oidc/callback", "n1"); !id.EmailVerified {
		t.Error("trust_email must mark the email verified")
	}
}
```

Plus a handler test (same file) for the routes: enabled provider `oidc:corp` with `erp_url` set → `OIDCAuthorize` returns `{url}` containing `redirect_uri=<erp_url>/api/auth/oidc/callback`; a provider not in `default`/`enabled` → 404; `OIDCExchange` with valid claims → `fakeSessions.issued` set; with wrong nonce → 401 "Sign-in failed.".

- [ ] **Step 2: Run to verify failure** — `cd core && go get github.com/coreos/go-oidc/v3 golang.org/x/oauth2 && go test ./internal/auth/providers/` → FAIL (undefined `NewOIDCClient`). (`go-jose/v4` arrives with go-oidc.)

- [ ] **Step 3: Implement `oidc.go`**

```go
package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ErrOIDC wraps every rejected OIDC exchange (bad token, PKCE, claims).
var ErrOIDC = errors.New("providers: oidc sign-in rejected")

type OIDCClient struct {
	http  *http.Client
	mu    sync.Mutex
	cache map[string]*oidc.Provider // by issuer
}

func NewOIDCClient(httpClient *http.Client) *OIDCClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &OIDCClient{http: httpClient, cache: map[string]*oidc.Provider{}}
}

func (o *OIDCClient) provider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if p, ok := o.cache[issuer]; ok {
		return p, nil
	}
	p, err := oidc.NewProvider(oidc.ClientContext(ctx, o.http), issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc: discovery %s: %w", issuer, err)
	}
	o.cache[issuer] = p
	return p, nil
}

func scopes(p OIDCProvider) []string {
	s := strings.Fields(p.Scopes)
	if len(s) == 0 {
		s = []string{"profile", "email"}
	}
	return append([]string{oidc.ScopeOpenID}, s...)
}

func (o *OIDCClient) config(ctx context.Context, p OIDCProvider, redirectURI string) (*oauth2.Config, *oidc.Provider, error) {
	prov, err := o.provider(ctx, p.Issuer)
	if err != nil {
		return nil, nil, err
	}
	return &oauth2.Config{ClientID: p.ClientID, ClientSecret: p.ClientSecret, Endpoint: prov.Endpoint(),
		RedirectURL: redirectURI, Scopes: scopes(p)}, prov, nil
}

func (o *OIDCClient) Check(ctx context.Context, p OIDCProvider) error {
	_, err := o.provider(ctx, p.Issuer)
	return err
}

func (o *OIDCClient) AuthorizeURL(ctx context.Context, p OIDCProvider, redirectURI, state, nonce, challenge string) (string, error) {
	cfg, _, err := o.config(ctx, p, redirectURI)
	if err != nil {
		return "", err
	}
	return cfg.AuthCodeURL(state, oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256")), nil
}

func (o *OIDCClient) Exchange(ctx context.Context, p OIDCProvider, code, verifier, redirectURI, nonce string) (ExternalIdentity, error) {
	ctx = oidc.ClientContext(ctx, o.http)
	cfg, prov, err := o.config(ctx, p, redirectURI)
	if err != nil {
		return ExternalIdentity{}, err
	}
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return ExternalIdentity{}, fmt.Errorf("%w: token exchange: %v", ErrOIDC, err)
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return ExternalIdentity{}, fmt.Errorf("%w: no id_token", ErrOIDC)
	}
	idt, err := prov.Verifier(&oidc.Config{ClientID: p.ClientID}).Verify(ctx, raw)
	if err != nil {
		return ExternalIdentity{}, fmt.Errorf("%w: %v", ErrOIDC, err)
	}
	if idt.Nonce != nonce {
		return ExternalIdentity{}, fmt.Errorf("%w: nonce mismatch", ErrOIDC)
	}
	var claims map[string]any
	if err := idt.Claims(&claims); err != nil {
		return ExternalIdentity{}, fmt.Errorf("%w: claims: %v", ErrOIDC, err)
	}
	str := func(k string) string { s, _ := claims[k].(string); return s }
	verified, _ := claims["email_verified"].(bool)
	return ExternalIdentity{
		Provider: "oidc:" + p.ID, Subject: idt.Subject, Email: str("email"),
		EmailVerified: verified || p.TrustEmail, DisplayName: str("name"),
		Groups: claimList(claims[p.GroupsClaim]),
	}, nil
}

// claimList reads a groups claim given as an array or a single string.
func claimList(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
```

(add `"time"` import.)

`handler.go` additions:

```go
// OIDCAuthorize handles GET /api/v1/auth/oidc/providers/:id/authorize.
func (h *Handler) OIDCAuthorize(c *echo.Context) error {
	state, nonce, challenge := c.QueryParam("state"), c.QueryParam("nonce"), c.QueryParam("code_challenge")
	if state == "" || nonce == "" || challenge == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "state, nonce and code_challenge are required")
	}
	p, m, err := h.enabledProvider(c)
	if err != nil {
		return err
	}
	url, err := h.deps.OIDC.AuthorizeURL(c.Request().Context(), p, m.CallbackURL(), state, nonce, challenge)
	if err != nil {
		return fmt.Errorf("oidc authorize: %w", err)
	}
	return c.JSON(http.StatusOK, map[string]string{"url": url})
}

func (h *Handler) enabledProvider(c *echo.Context) (OIDCProvider, Methods, error) {
	notFound := echo.NewHTTPError(http.StatusNotFound, "not found")
	if h.deps.Tenant == uuid.Nil {
		return OIDCProvider{}, Methods{}, notFound
	}
	m, err := h.deps.Store.Load(c.Request().Context(), h.deps.Tenant)
	if err != nil {
		return OIDCProvider{}, Methods{}, err
	}
	id := c.Param("id")
	p, ok := m.Provider(id)
	if !ok || !m.Allows("oidc:"+id) {
		return OIDCProvider{}, Methods{}, notFound
	}
	return p, m, nil
}

// OIDCExchange handles POST /api/v1/auth/oidc/providers/:id/exchange.
func (h *Handler) OIDCExchange(c *echo.Context) error {
	const msg = "Sign-in failed."
	var req struct {
		Code         string `json:"code"`
		CodeVerifier string `json:"code_verifier"`
		Nonce        string `json:"nonce"`
	}
	if err := c.Bind(&req); err != nil || req.Code == "" || req.CodeVerifier == "" || req.Nonce == "" {
		return unauthorized(c, msg)
	}
	p, m, err := h.enabledProvider(c)
	if err != nil {
		return unauthorized(c, msg)
	}
	ctx := c.Request().Context()
	id, err := h.deps.OIDC.Exchange(ctx, p, req.Code, req.CodeVerifier, m.CallbackURL(), req.Nonce)
	if err != nil {
		if errors.Is(err, ErrOIDC) {
			return unauthorized(c, msg)
		}
		return fmt.Errorf("oidc exchange: %w", err)
	}
	userID, err := h.provision(ctx, h.deps.Tenant, id, m)
	if err != nil {
		if errors.Is(err, ErrRefused) {
			return unauthorized(c, msg)
		}
		return err
	}
	return h.deps.Sessions.IssueSessionForUser(c, userID)
}
```

and in `TestSettings`'s switch:

```go
	case strings.HasPrefix(req.Method, "oidc:"):
		p, ok := m.Provider(strings.TrimPrefix(req.Method, "oidc:"))
		if !ok {
			return echo.NewHTTPError(http.StatusBadRequest, "unknown or unconfigured method")
		}
		testErr = h.deps.OIDC.Check(ctx, p)
```

- [ ] **Step 4: Run** — `cd core && go test ./internal/auth/providers/` → PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/go.mod core/go.sum core/internal/auth/providers
rtk git commit -m "feat(auth): OIDC sign-in (authorization code + PKCE)"
```

---

### Task 6: Wiring, session issuance and app-level tests

**Files:**
- Modify: `core/internal/auth/handler.go` (`IssueSessionForUser`)
- Modify: `core/internal/app/app.go` (construct and mount)
- Create: `core/internal/app/external_auth_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `func (h *Handler) IssueSessionForUser(c *echo.Context, userID uuid.UUID) error` on `*auth.Handler` (loads the user with `FindByID`, refuses — generic 401 — a deleted user or a website user, then `issueSession`).
- Routes mounted:
  - `GET /api/v1/auth/methods`, `POST /api/v1/auth/ldap/login`, `GET /api/v1/auth/oidc/providers/:id/authorize`, `POST /api/v1/auth/oidc/providers/:id/exchange` on the existing `authGroup` (auth rate limiter, no JWT);
  - `GET|PUT /api/v1/settings/auth`, `POST /api/v1/settings/auth/test` on `settingsGroup` (permissions `settings:auth:*` derived).

- [ ] **Step 1: Failing app test**

```go
// core/internal/app/external_auth_test.go
package app

// Uses the package's existing app builder and client helpers (see app_test.go).
// The external-auth handler is reachable through real routes; the LDAP
// directory is swapped for a fake via the exported test hook
// SetDirectoryForTest (added in this task, test-only file export_test.go).

func TestExternalAuth_RoutesAndFallback(t *testing.T) {
	c := buildApp(t) // or buildSiteApp, whichever app_test.go provides with an admin token
	anon := &client{t: t, h: c.h}

	// Public methods: always answers, local by default (Review Focus 1).
	code, body := anon.do(http.MethodGet, "/api/v1/auth/methods", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"local"`) {
		t.Fatalf("methods = %d %s", code, body)
	}
	// Settings require a token.
	if code, _ := anon.do(http.MethodGet, "/api/v1/settings/auth", nil); code != http.StatusUnauthorized {
		t.Errorf("anonymous settings = %d", code)
	}
	if code, body := c.do(http.MethodGet, "/api/v1/settings/auth", nil); code != http.StatusOK {
		t.Errorf("admin settings = %d %s", code, body)
	}
	// LDAP not configured → 401, never 500.
	if code, _ := anon.do(http.MethodPost, "/api/v1/auth/ldap/login", map[string]string{"username": "a", "password": "b"}); code != http.StatusUnauthorized {
		t.Errorf("ldap unconfigured = %d", code)
	}
	// Unknown OIDC provider → 404.
	if code, _ := anon.do(http.MethodGet, "/api/v1/auth/oidc/providers/nope/authorize?state=s&nonce=n&code_challenge=c", nil); code != http.StatusNotFound {
		t.Errorf("unknown provider = %d", code)
	}
	// Local login still works whatever the auth settings hold.
	code, _ = anon.do(http.MethodPost, "/api/v1/auth/login", map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword})
	if code != http.StatusOK {
		t.Errorf("local login = %d", code)
	}
}
```

Add a second test, `TestExternalAuth_LDAPEndToEnd`, that saves real settings through `PUT /api/v1/settings/auth` (an LDAP config + a mapping of group `ext-test` to the seeded admin role; read the admin role id from `GET /api/v1/roles`), injects a fake directory returning an identity for a fresh `uuid` email with groups `["ext-test"]`, logs in via `POST /api/v1/auth/ldap/login`, asserts 200 + an `access_token`, and cleans up: the created user's `auth_identity`, `user_roles`, `users` rows, and restores the previous `auth.methods` setting value.

- [ ] **Step 2: Run to verify failure** — `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -timeout 600s -run TestExternalAuth ./internal/app/` → FAIL (routes 404).

- [ ] **Step 3: Implement**

`core/internal/auth/handler.go`:

```go
// IssueSessionForUser issues the normal ERP session for an already
// externally-authenticated user (LDAP/OIDC, internal/auth/providers).
// A deleted or website user gets the same generic 401 as a bad password.
func (h *Handler) IssueSessionForUser(c *echo.Context, userID uuid.UUID) error {
	user, err := h.users.FindByID(c.Request().Context(), userID)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) || errors.Is(err, ErrUserNotFound) {
			return h.unauthMsg(c, "Invalid username or password.")
		}
		return fmt.Errorf("external login: %w", err)
	}
	if user.DeletedAt != nil || !h.kindMatches(user) {
		return h.unauthMsg(c, "Invalid username or password.")
	}
	return h.issueSession(c, user)
}
```

`core/internal/app/app.go`: right after `authGroup.POST("/logout", …)` the site tenant isn't resolved yet (it is resolved later, at the "Website published data" block). Move the external-auth mounting to just after `siteTenant` is resolved:

```go
	// External ERP sign-in (ADR-030): LDAP / OIDC + the login screen's methods.
	secretBox, err := providers.NewSecretBox(configContent.MasterPassword)
	if err != nil {
		return nil, fmt.Errorf("auth secrets: %w", err)
	}
	roleRepo := auth.NewRoleRepository(app.DB)
	extAuth := providers.NewHandler(providers.Deps{
		Store:  providers.NewStore(settings.NewRepository(app.DB), secretBox),
		Tenant: siteTenant,
		Roles: func(ctx context.Context, tenant uuid.UUID) (map[uuid.UUID]bool, error) {
			list, err := roleRepo.ListByTenant(ctx, tenant)
			if err != nil {
				return nil, err
			}
			out := make(map[uuid.UUID]bool, len(list))
			for _, r := range list {
				out[r.ID] = true
			}
			return out, nil
		},
		Directory:   providers.LDAPDirectory{},
		OIDC:        providers.NewOIDCClient(nil),
		Provisioner: providers.NewProvisioner(app.DB),
		Sessions:    authHandler,
	})
	authGroup.GET("/methods", extAuth.PublicMethods)
	authGroup.POST("/ldap/login", extAuth.LDAPLogin)
	authGroup.GET("/oidc/providers/:id/authorize", extAuth.OIDCAuthorize)
	authGroup.POST("/oidc/providers/:id/exchange", extAuth.OIDCExchange)
	settingsGroup.GET("/auth", extAuth.GetSettings)
	settingsGroup.PUT("/auth", extAuth.PutSettings)
	settingsGroup.POST("/auth/test", extAuth.TestSettings)
```

(Keep `authGroup` in scope — it's declared earlier in the same function. If `Build`'s return signature differs, return the error the way neighbouring code does. Adapt `roleRepo.ListByTenant`'s actual signature.) Add a test-only export (`core/internal/app/export_test.go` or the existing one) to swap the directory: keep a package-level reference to `extAuth` on the `App` struct (e.g. `a.extAuth`) and expose `providers.(*Handler).SetDirectory(d Directory)` used only by tests.

- [ ] **Step 4: Run** — `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -timeout 900s ./internal/auth/... ./internal/app/` → PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/auth core/internal/app
rtk git commit -m "feat(auth): mount external sign-in routes and settings"
```

---

### Task 7: BFF routes (LDAP relay, OIDC start/callback, methods)

**Files:**
- Create: `core-front/apps/shell/src/lib/auth-methods.ts` (+ `.test.ts`)
- Create: `core-front/apps/shell/app/api/auth/ldap/route.ts` (+ `route.test.ts`)
- Create: `core-front/apps/shell/app/api/auth/oidc/[provider]/start/route.ts` (+ `route.test.ts`)
- Create: `core-front/apps/shell/app/api/auth/oidc/callback/route.ts` (+ `route.test.ts`)

**Interfaces:**
- Consumes: Go routes from Task 6; `goAuthExchange(path, body)`, `setSessionCookies(tokens)`, `forwardedFor()` from `@/lib/bff`; `identityFromAccessToken` from `@/lib/jwt`; `erpPath` from `@eerp/core-front`.
- Produces:
  - `export interface LoginMethod { id: string; kind: 'password' | 'redirect'; label: string }`; `export interface LoginMethods { default: LoginMethod; alternatives: LoginMethod[] }`; `export async function getLoginMethods(): Promise<LoginMethods>` (server-only; any failure → `{ default: { id: 'local', kind: 'password', label: '' }, alternatives: [] }`).
  - `POST /api/auth/ldap {username, password}` → `{identity}` like `/api/auth/login`.
  - `GET /api/auth/oidc/[provider]/start?next=` → 302 to the IdP; cookie `eerp_oidc` (httpOnly, SameSite=Lax, Secure in production, path `/api/auth/oidc`, maxAge 600) holding JSON `{provider, state, nonce, verifier, next}`.
  - `GET /api/auth/oidc/callback?code=&state=` → 302 to `erpPath(next)` with session cookies, or to `erpPath('/login?error=sso')` on any failure; always deletes `eerp_oidc`.

- [ ] **Step 1: Failing tests** (all `// @vitest-environment node`, mocking `@/lib/bff` and `next/headers` cookies like `app/api/auth/login/route.test.ts`):
  - `auth-methods.test.ts`: Go answers → parsed; Go 500 / network error → local fallback.
  - `ldap/route.test.ts`: forwards `{username, password}` to `goAuthExchange('ldap/login', …)`, sets cookies, returns `{identity}`; relays a 401 `ApiError` as 401 with Go's message.
  - `start/route.test.ts`: fetches `…/auth/oidc/providers/corp/authorize?state=&nonce=&code_challenge=` where `code_challenge` = base64url(sha256(verifier)) of the verifier stored in the cookie; redirects 302 to Go's `url`; cookie set with httpOnly + SameSite=lax + maxAge 600; `next` stored; Go 404 → redirect to `/app/login?error=sso`.
  - `callback/route.test.ts` (Review Focus 4): no cookie → redirect `?error=sso` and no exchange call; `state` mismatch → same; valid → `goAuthExchange('oidc/providers/corp/exchange', {code, code_verifier, nonce})`, session cookies set, redirect to `erpPath(next)`, `eerp_oidc` deleted; `?error=access_denied` → `?error=sso`; a `next` of `//evil.example` lands inside the ERP (`erpPath` normalizes).

- [ ] **Step 2: Run to verify failure** — `cd core-front/apps/shell && npx vitest run app/api/auth src/lib/auth-methods.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/lib/auth-methods.ts`:

```ts
import 'server-only'
import { forwardedFor } from './bff'

export interface LoginMethod {
  id: string
  kind: 'password' | 'redirect'
  label: string
}
export interface LoginMethods {
  default: LoginMethod
  alternatives: LoginMethod[]
}

const LOCAL_ONLY: LoginMethods = { default: { id: 'local', kind: 'password', label: '' }, alternatives: [] }

/** The login screen's methods (Go /auth/methods). Any failure degrades to
 * local password only — a broken IdP config never hides the local form. */
export async function getLoginMethods(): Promise<LoginMethods> {
  try {
    const res = await fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/auth/methods`, {
      cache: 'no-store',
      headers: await forwardedFor(),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return LOCAL_ONLY
    const body = (await res.json()) as LoginMethods
    return body?.default?.id ? { default: body.default, alternatives: body.alternatives ?? [] } : LOCAL_ONLY
  } catch {
    return LOCAL_ONLY
  }
}
```

`app/api/auth/ldap/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { goAuthExchange, setSessionCookies } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'

// POST /api/auth/ldap {username, password} — directory sign-in, same cookie
// handling as /api/auth/login.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string }
  try {
    const tokens = await goAuthExchange('ldap/login', { username: body.username, password: body.password })
    await setSessionCookies(tokens)
    return NextResponse.json({ identity: identityFromAccessToken(tokens.accessToken) })
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: { code: e.code, message: e.message, requestId: e.requestId } }, { status: e.status })
    }
    throw e
  }
}
```

`app/api/auth/oidc/[provider]/start/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { erpPath } from '@eerp/core-front'
import { forwardedFor } from '@/lib/bff'

export const OIDC_COOKIE = 'eerp_oidc'

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url')
}
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)))

// GET /api/auth/oidc/[provider]/start?next= — PKCE + state + nonce kept in a
// short-lived httpOnly cookie; Go builds the authorize URL (and its fixed
// redirect URI) from the auth settings.
export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params
  const next = new URL(request.url).searchParams.get('next') ?? '/'
  const state = random()
  const nonce = random()
  const verifier = random()
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const fail = NextResponse.redirect(new URL(erpPath('/login?error=sso'), request.url))

  const qs = new URLSearchParams({ state, nonce, code_challenge: challenge })
  const res = await fetch(
    `${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/auth/oidc/providers/${encodeURIComponent(provider)}/authorize?${qs}`,
    { cache: 'no-store', headers: await forwardedFor(), signal: AbortSignal.timeout(5000) },
  ).catch(() => null)
  if (!res?.ok) return fail
  const body = (await res.json().catch(() => null)) as { url?: string } | null
  if (!body?.url) return fail

  ;(await cookies()).set(OIDC_COOKIE, JSON.stringify({ provider, state, nonce, verifier, next }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth/oidc',
    maxAge: 600,
  })
  return NextResponse.redirect(body.url)
}
```

`app/api/auth/oidc/callback/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { erpPath } from '@eerp/core-front'
import { goAuthExchange, setSessionCookies } from '@/lib/bff'

const OIDC_COOKIE = 'eerp_oidc'

// GET /api/auth/oidc/callback?code=&state= — the provider returns here. The
// state must match the cookie set by /start (CSRF); the cookie is always
// cleared; any failure lands on the login page with a generic message.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const jar = await cookies()
  const raw = jar.get(OIDC_COOKIE)?.value
  jar.delete(OIDC_COOKIE)
  const fail = NextResponse.redirect(new URL(erpPath('/login?error=sso'), request.url))

  let saved: { provider?: string; state?: string; nonce?: string; verifier?: string; next?: string } | null = null
  try {
    saved = raw ? JSON.parse(raw) : null
  } catch {
    saved = null
  }
  const code = params.get('code')
  if (!saved?.provider || !saved.state || !code || params.get('error') || params.get('state') !== saved.state) return fail

  try {
    const tokens = await goAuthExchange(`oidc/providers/${encodeURIComponent(saved.provider)}/exchange`, {
      code,
      code_verifier: saved.verifier,
      nonce: saved.nonce,
    })
    await setSessionCookies(tokens)
  } catch {
    return fail
  }
  return NextResponse.redirect(new URL(erpPath(saved.next || '/'), request.url))
}
```

(Export `OIDC_COOKIE` from a shared `src/lib/oidc.ts` instead of the route file if Next forbids non-handler exports from route modules — it does for some names; keep route files exporting only `GET`/`POST`.)

- [ ] **Step 4: Run** — `cd core-front/apps/shell && npx vitest run app/api/auth src/lib && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell/app/api/auth core-front/apps/shell/src/lib
rtk git commit -m "feat(front): BFF routes for LDAP and OIDC sign-in"
```

---

### Task 8: Login screen

**Files:**
- Modify: `core-front/apps/shell/app/app/login/page.tsx` (server wrapper)
- Create: `core-front/apps/shell/app/app/login/LoginScreen.tsx` (client)
- Modify: `core-front/apps/shell/app/app/login/page.test.tsx`
- Modify: `core-front/apps/shell/i18n/shell.pot`, `core-front/apps/shell/i18n/fr.po`

**Interfaces:**
- Consumes: `getLoginMethods`, `LoginMethods` (Task 7); BFF `/api/auth/login`, `/api/auth/ldap`, `/api/auth/oidc/[provider]/start`.
- Produces: `LoginScreen({ methods }: { methods: LoginMethods })`.

- [ ] **Step 1: Failing tests** — rewrite `page.test.tsx` to render `<LoginScreen methods={…} />` directly (the page becomes an async server component), keeping the existing local-login assertions, plus:
  - default `local` → email + password form, "Sign in"; posts to `authBffUrl('login')` with `{email, password}` (existing behavior kept);
  - default `ldap` (label "Company directory") → heading/label "Company directory", a "Username" field, posts to `/api/auth/ldap` with `{username, password}`; a 401 shows Go's message;
  - default `oidc:corp` (label "Authentik") → a "Continue with Authentik" link whose `href` is `/api/auth/oidc/corp/start?next=<next>`, no password field;
  - alternatives: an `oidc:google` alternative renders "Continue with Google" below an "or" divider; a `local` alternative renders "Sign in with email and password", clicking it swaps the top form to local;
  - `?method=local` (mock `useSearchParams`) with default `oidc:corp` → the local form is on top (Review Focus 1);
  - `?error=sso` → an error alert "Single sign-on failed. Try again or use another method.".

- [ ] **Step 2: Run to verify failure** — `cd core-front/apps/shell && npx vitest run app/app/login` → FAIL.

- [ ] **Step 3: Implement**

`page.tsx`:

```tsx
import Container from '@mui/material/Container'
import { Suspense } from 'react'
import { getLoginMethods } from '@/lib/auth-methods'
import LoginScreen from './LoginScreen'

// The ERP login (ADR-030): the default method on top, the enabled
// alternatives below. getLoginMethods never throws — local is the fallback.
export default async function LoginPage() {
  const methods = await getLoginMethods()
  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <LoginScreen methods={methods} />
      </Suspense>
    </Container>
  )
}
```

`LoginScreen.tsx` — move the current `LoginForm` here and generalize:

```tsx
'use client'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { erpPath, useSessionStore, useT } from '@eerp/core-front'
import { authBffUrl } from '@/lib/auth-url'
import type { LoginMethod, LoginMethods } from '@/lib/auth-methods'

const FORCE_PASSWORD_CHANGE_PATH = erpPath('/force-password-change')
const LOCAL: LoginMethod = { id: 'local', kind: 'password', label: '' }

function PasswordForm({ method }: { method: LoginMethod }) {
  const t = useT()
  const router = useRouter()
  const params = useSearchParams()
  const isLocal = method.id === 'local'
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const res = await fetch(isLocal ? authBffUrl('login') : '/api/auth/ldap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isLocal ? { email: user, password } : { username: user, password }),
    })
    const data = (await res.json().catch(() => null)) as { identity?: unknown; error?: { message?: string } } | null
    if (!res.ok) {
      setError(data?.error?.message ?? t('Login failed'))
      setPending(false)
      return
    }
    const identity = (data?.identity as { mustChangePassword?: boolean } | undefined) ?? null
    useSessionStore.getState().setIdentity(identity as never)
    router.push(erpPath(identity?.mustChangePassword ? FORCE_PASSWORD_CHANGE_PATH : params.get('next') || '/'))
    router.refresh()
  }

  return (
    <Box component="form" onSubmit={onSubmit}>
      <Stack spacing={2}>
        {method.label && <Typography variant="subtitle1">{method.label}</Typography>}
        {error ? <Alert severity="error">{error}</Alert> : null}
        <TextField
          id="login-user"
          label={isLocal ? t('Email') : t('Username')}
          type={isLocal ? 'email' : 'text'}
          autoComplete={isLocal ? 'email' : 'username'}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          required
        />
        <TextField
          id="login-password"
          label={t('Password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Button type="submit" variant="contained" disabled={pending}>
          {pending ? t('Signing in…') : t('Sign in')}
        </Button>
      </Stack>
    </Box>
  )
}

function RedirectButton({ method, primary }: { method: LoginMethod; primary: boolean }) {
  const t = useT()
  const params = useSearchParams()
  const provider = method.id.replace(/^oidc:/, '')
  const href = `/api/auth/oidc/${encodeURIComponent(provider)}/start?next=${encodeURIComponent(params.get('next') || '/')}`
  return (
    <Button component="a" href={href} variant={primary ? 'contained' : 'outlined'} size={primary ? 'large' : 'medium'} fullWidth>
      {t('Continue with')} {method.label}
    </Button>
  )
}

export default function LoginScreen({ methods }: { methods: LoginMethods }) {
  const t = useT()
  const params = useSearchParams()
  const forced = params.get('method') === 'local'
  const [top, setTop] = useState<LoginMethod>(forced ? LOCAL : methods.default)
  const all = [methods.default, ...methods.alternatives]
  const others = all.filter((m) => m.id !== top.id)

  return (
    <Stack spacing={3}>
      <Typography variant="h5" component="h1">
        {t('Sign in')}
      </Typography>
      {params.get('error') === 'sso' && (
        <Alert severity="error">{t('Single sign-on failed. Try again or use another method.')}</Alert>
      )}
      {top.kind === 'password' ? <PasswordForm key={top.id} method={top} /> : <RedirectButton method={top} primary />}
      {others.length > 0 && (
        <>
          <Divider>{t('or')}</Divider>
          <Stack spacing={1}>
            {others.map((m) =>
              m.kind === 'redirect' ? (
                <RedirectButton key={m.id} method={m} primary={false} />
              ) : (
                <Link key={m.id} component="button" type="button" onClick={() => setTop(m)}>
                  {m.id === 'local' ? t('Sign in with email and password') : `${t('Sign in with')} ${m.label || t('the company directory')}`}
                </Link>
              ),
            )}
          </Stack>
        </>
      )}
    </Stack>
  )
}
```

Add every new string (`Email`, `Username`, `Password`, `Sign in`, `Signing in…`, `Login failed`, `Continue with`, `or`, `Sign in with email and password`, `Sign in with`, `the company directory`, `Single sign-on failed. Try again or use another method.`) to `shell.pot` (empty msgstr) and `fr.po` (Email → E-mail; Username → Nom d'utilisateur; Password → Mot de passe; Sign in → Se connecter; Signing in… → Connexion…; Login failed → Échec de la connexion; Continue with → Continuer avec; or → ou; Sign in with email and password → Se connecter avec e-mail et mot de passe; Sign in with → Se connecter avec; the company directory → l'annuaire de l'entreprise; Single sign-on failed… → La connexion unique a échoué. Réessayez ou utilisez une autre méthode.) — skip any msgid already present.

- [ ] **Step 4: Run** — `cd core-front/apps/shell && npx vitest run app/app/login && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell/app/app/login core-front/apps/shell/i18n
rtk git commit -m "feat(front): login screen with default and alternative methods"
```

---

### Task 9: Settings → Authentication page

**Files:**
- Create: `core-front/apps/shell/src/lib/auth-settings.ts` (Server Actions), `core-front/apps/shell/app/app/settings/authentication/page.tsx`, `core-front/apps/shell/app/app/settings/authentication/AuthSettingsForm.tsx`, `core-front/apps/shell/app/app/settings/authentication/AuthSettingsForm.test.tsx`
- Modify: `core-front/apps/shell/app/app/settings/SettingsHub.tsx` (new section)
- Modify: `core-front/apps/shell/i18n/shell.pot`, `fr.po`

**Interfaces:**
- Consumes: Go `GET|PUT /api/v1/settings/auth`, `POST /api/v1/settings/auth/test`, `GET /api/v1/roles` (role list `{id, name}`).
- Produces: `getAuthSettings(): Promise<AuthSettingsView>`, `saveAuthSettings(s: AuthSettingsInput): Promise<SaveResult>`, `testAuthMethod(method: string): Promise<{ ok: boolean; message: string }>`, `listRoles(): Promise<{ id: string; name: string }[]>` — all `'use server'` async functions returning result objects (pattern of `src/lib/website-settings.ts`).

- [ ] **Step 1: Failing tests** — `AuthSettingsForm.test.tsx` (mock `@/lib/auth-settings`):
  - renders the default-method select with Local + LDAP (when configured) + each provider, and alternative checkboxes;
  - "LLDAP defaults" fills user filter `(&(objectClass=person)(uid={username}))`, email `mail`, name `cn`, groups `memberOf`;
  - a stored bind password shows "Stored — leave empty to keep" and submits `bind_password: ""` unless typed;
  - adding an OIDC provider shows its callback URL (from `callback_url`) read-only;
  - the role mapping row picks a role id from `listRoles()` and submits `{group, role_id}`;
  - Save posts the full object; a Go 400 message is shown in an error alert;
  - "Test connection" calls `testAuthMethod('ldap')` and shows the message.

- [ ] **Step 2: Run to verify failure** — `cd core-front/apps/shell && npx vitest run app/app/settings/authentication` → FAIL.

- [ ] **Step 3: Implement** — `auth-settings.ts` (copy the `save`/`failure` helpers' shape from `src/lib/website-settings.ts`):

```ts
'use server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

export type SaveResult = { ok: true } | { ok: false; message: string }

export interface LDAPSettings {
  label: string; url: string; start_tls: boolean; bind_dn: string; bind_password?: string
  base_dn: string; user_filter: string; email_attr: string; name_attr: string
  groups_attr: string; group_search_base: string; group_filter: string
  has_bind_password?: boolean
}
export interface OIDCSettings {
  id: string; label: string; issuer: string; client_id: string; client_secret?: string
  scopes: string; groups_claim: string; trust_email: boolean; has_client_secret?: boolean
}
export interface AuthSettingsView {
  default: string; enabled: string[]; ldap?: LDAPSettings | null; oidc: OIDCSettings[]
  role_mapping: { group: string; role_id: string }[]; default_role_id: string | null
  erp_url: string; callback_url: string
}
export type AuthSettingsInput = Omit<AuthSettingsView, 'callback_url'>

const EMPTY: AuthSettingsView = { default: 'local', enabled: [], ldap: null, oidc: [], role_mapping: [], default_role_id: null, erp_url: '', callback_url: '' }

export async function getAuthSettings(): Promise<AuthSettingsView> {
  try {
    const s = await apiRequest<AuthSettingsView>('GET', '/settings/auth')
    return { ...EMPTY, ...s, oidc: s.oidc ?? [], role_mapping: s.role_mapping ?? [], enabled: s.enabled ?? [] }
  } catch {
    return EMPTY
  }
}

export async function saveAuthSettings(s: AuthSettingsInput): Promise<SaveResult> {
  try {
    await apiRequest('PUT', '/settings/auth', s)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function testAuthMethod(method: string): Promise<{ ok: boolean; message: string }> {
  try {
    return await apiRequest<{ ok: boolean; message: string }>('POST', '/settings/auth/test', { method })
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : '' }
  }
}

export async function listRoles(): Promise<{ id: string; name: string }[]> {
  try {
    const roles = await apiRequest<{ data?: { id: string; name: string }[] } | { id: string; name: string }[]>('GET', '/roles')
    return Array.isArray(roles) ? roles : (roles.data ?? [])
  } catch {
    return []
  }
}
```

`page.tsx` (pattern of `app/app/settings/website/routing/page.tsx`): `requireAuth('/settings/authentication')`, load `getAuthSettings()` and `listRoles()`, render `<AuthSettingsForm initial={…} roles={…} />` under an "Authentication" heading.

`AuthSettingsForm.tsx`: a client component with local state of `AuthSettingsInput`, sections as described in the spec (default select; alternatives checkboxes; LDAP accordion with "LLDAP defaults" + fields + bind password `type="password"` with helper "Stored — leave empty to keep" when `has_bind_password`; OIDC list with add/remove, per-provider fields, client secret write-only like the bind password, read-only callback URL `initial.callback_url || '<ERP URL>/api/auth/oidc/callback'`, "Test discovery" button; ERP URL field; role mapping table with group text field + role `select` from `roles` + remove; default role select with "— none (refuse) —"; Save → `saveAuthSettings` → success/error alert). Strip `has_*` and `callback_url` from the submitted object.

`SettingsHub.tsx` `SETTINGS_SECTIONS`, before `/settings/website`:

```ts
  {
    path: '/settings/authentication',
    title: 'Authentication',
    description: 'Sign-in methods: password, company directory (LDAP), single sign-on (OIDC).',
  },
```

Add all new strings to `shell.pot` + `fr.po` (French: Authentication → Authentification; Default method → Méthode par défaut; Alternatives → Alternatives; Company directory (LDAP) → Annuaire de l'entreprise (LDAP); LLDAP defaults → Valeurs par défaut LLDAP; Test connection → Tester la connexion; Test discovery → Tester la découverte; Stored — leave empty to keep → Enregistré — laisser vide pour conserver; Callback URL → URL de rappel; Group → Groupe; Role → Rôle; Default role → Rôle par défaut; — none (refuse) — → — aucun (refuser) —; Add provider → Ajouter un fournisseur; ERP public URL → URL publique de l'ERP; etc. for every label used).

- [ ] **Step 4: Run** — `cd core-front/apps/shell && npx vitest run && npx tsc --noEmit -p .` → PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell
rtk git commit -m "feat(front): Settings → Authentication page"
```

---

### Task 10: Documentation and full verification

**Files:**
- Create: `docs/adr/ADR-030-external-authentication.md`
- Modify: `CLAUDE.md` (`internal/auth/providers` bullet; routes; secrets pitfall), `core-front/CLAUDE.md` (login screen, BFF routes, settings page)

- [ ] **Step 1: Write ADR-030** — Context (staff sign-in through the directory/SSO), Decision (pipeline: authenticate → `ExternalIdentity` → `Provisioner` → `IssueSessionForUser`; LDAP search+bind; OIDC code+PKCE via BFF with state cookie; Go-built redirect URI from `erp_url`; settings `auth.methods`, secrets AES-GCM under `master_key`; public `/auth/methods`; `?method=local` fallback), a Mermaid sequence of the OIDC flow (browser → BFF start → Go authorize → IdP → BFF callback → Go exchange → Provisioner → session cookies), Consequences, and the spec's Pitfalls list.

- [ ] **Step 2: Update CLAUDE.md files** — concise bullets pointing to ADR-030; mention `LDAP_TEST_URL` for the optional live test.

- [ ] **Step 3: Full verification**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -timeout 1500s ./...` and `cd core-front && (cd packages/core-front && npx -y pnpm@12.4.2 build) && npx -y pnpm@12.4.2 -r --no-bail --workspace-concurrency=1 test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/adr/ADR-030-external-authentication.md CLAUDE.md core-front/CLAUDE.md
rtk git commit -m "docs: ADR-030 external authentication"
```
