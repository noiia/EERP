# External authentication (LDAP / OIDC) and configurable login — design

Date: 2026-10-10 · Status: approved in conversation, pending spec review

## Goal

Let ERP staff sign in through the company directory (LLDAP, or any LDAP server) or through
one or more OpenID Connect providers, next to the existing local email + password login, and
let an administrator choose which method the login screen shows first and which alternatives
appear below it.

Scope: the **ERP staff login** (`/app/login`) only. The website visitor login (`/login`) is
unchanged.

Non-goals (v1): SAML, LDAP password changes from the ERP, SCIM/background directory sync
(roles sync at login time only), website visitor SSO, per-company (rather than per-workspace)
provider configuration.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Accounts | auto-create on first login + group → role mapping re-applied at every login | the directory/IdP stays the source of truth for who belongs where |
| Login screen | admin picks a default method (top) and enables alternatives (below); local password always reachable at `?method=local` | no admin lockout from a broken IdP config |
| OIDC providers | several | e.g. Authentik + Google + Microsoft side by side |
| LDAP | generic LDAP with LLDAP presets | works with LLDAP, OpenLDAP, Active Directory |
| Secrets | AES-GCM encrypted with the existing `master_key`, write-only in the API | an `app_settings` dump never reveals a client secret or bind password |
| Session | every method ends in the existing `issueSession` | tokens, refresh, roles, groups, permissions identical to a password login |

## 1. Backend

### Sign-in pipeline (`core/internal/auth/providers`)

Each method only authenticates and returns an `ExternalIdentity`:

```go
type ExternalIdentity struct {
    Provider      string   // "ldap" or "oidc:<provider id>"
    Subject       string   // stable id at the provider (LDAP entry DN / uid, OIDC `sub`)
    Email         string
    EmailVerified bool     // LDAP: true (admin-controlled directory); OIDC: the email_verified claim
    DisplayName   string
    Groups        []string // LDAP memberOf / group search; OIDC: the configured groups claim
}
```

`Provision(ctx, ExternalIdentity) (Users, error)`, shared by all methods, runs in one
transaction:

1. find the ERP user linked to `(provider, subject)` in the new `auth_identity` table
   (`tenant_id`, `user_id`, `provider`, `subject`, `created_at`; unique `(tenant_id, provider,
   subject)`, hand-written in the auth module's `Migrate`);
2. else, **only if `EmailVerified`**, the existing ERP user (kind `erp`) with the same email
   (case-insensitive) — then link it; an account already linked to a *different* subject of the
   same provider is never relinked (refused);
3. else create the user (kind `erp`, locked local password — random discarded hash, as for an
   admin-created user without password) and link it;
4. re-apply roles from the group mapping: the user's roles become exactly the mapped roles of
   their groups, or the configured default role when none match; roles assigned manually in
   the ERP to a provider-managed user are replaced (documented);
5. refuse when the user is soft-deleted/disabled, or ends with no role.

Then the existing `issueSession`. A provisioning refusal answers the same generic 401 as a
bad password.

### Local password
Unchanged: `POST /api/v1/auth/login`.

### LDAP
`POST /api/v1/auth/ldap/login {username, password}`:
- connect (`ldaps://`, or `ldap://` + StartTLS; plain `ldap://` without StartTLS refused
  unless the host is loopback), bind with the service account, search the user with the
  configured filter (`{username}` escaped per RFC 4515), require exactly one entry, bind as
  that entry with the given password, read email / display name / groups (`memberOf`, or a
  group search when configured);
- unknown user, several matches and wrong password take comparable time and return the same
  401 "Invalid username or password.";
- empty password refused before any bind (an anonymous bind must never count as success);
- library `github.com/go-ldap/ldap/v3`, behind a small `directory` interface so tests can fake it.

LLDAP presets: user filter `(&(objectClass=person)(uid={username}))`, base `ou=people,<base>`,
email `mail`, name `cn` (fallback `displayName`), groups `memberOf` (CN of each DN).

### OIDC
Authorization Code + PKCE (S256), browser bouncing through the Next BFF:
- `GET /api/v1/auth/oidc/providers/:id/authorize?redirect_uri=&state=&nonce=&code_challenge=`
  → `{url}` built from the provider's discovery document (cached per issuer);
- `POST /api/v1/auth/oidc/providers/:id/exchange {code, code_verifier, redirect_uri, nonce}`
  → exchanges the code, verifies the ID token (signature via the issuer's JWKS, `iss`, `aud`,
  `exp`, `nonce`), reads `sub`, `email`, `email_verified` (a provider setting may treat emails
  as verified, for IdPs that omit the claim), `name`, the configured groups claim (string or
  array), provisions, issues the session;
- `redirect_uri` must equal `<erp_url>/api/auth/oidc/callback`, `erp_url` being the ERP's
  public origin set in the auth settings (required as soon as an OIDC provider is enabled);
- libraries `github.com/coreos/go-oidc/v3`, `golang.org/x/oauth2`.

### Settings
`app_settings` key `auth.methods`, in the workspace's site-wide slot (`company_id = uuid.Nil`)
of the tenant resolved like the website tenant:

```jsonc
{
  "default": "local" | "ldap" | "oidc:<id>",
  "enabled": ["ldap", "oidc:authentik"],            // alternatives shown below the default
  "ldap": { "label", "url", "start_tls", "bind_dn", "bind_password_enc", "base_dn",
            "user_filter", "email_attr", "name_attr", "groups_attr", "group_search_base",
            "group_filter" },
  "oidc": [ { "id", "label", "issuer", "client_id", "client_secret_enc", "scopes",
              "groups_claim", "trust_email" } ],
  "role_mapping": [ { "group": "erp-admins", "role": "admin" } ],
  "default_role": "user" | "",                      // "" = refuse users matching no group
  "erp_url": "https://erp.example.com"              // public ERP origin; builds the OIDC callback URL
}
```

- `GET|PUT /api/v1/settings/auth` (`settings:auth:read|write`): secrets are write-only —
  GET returns `has_bind_password` / `has_client_secret` booleans; a PUT with an empty secret
  keeps the stored one. Validation: ids lowercase-dash, unique; issuer/URL schemes; the
  default and every enabled method configured; mapped roles exist.
- Secrets encrypted with AES-GCM under a key derived from `master_key` (HKDF, purpose label
  `eerp/auth-secrets`).
- `POST /api/v1/settings/auth/test {method}` → LDAP: service bind + base search; OIDC:
  discovery fetch. Answers `{ok, message}`.
- `GET /api/v1/auth/methods` (anonymous, auth rate limiter): `{default, alternatives:
  [{id, kind: "password"|"redirect", label}]}` — no URLs, no secrets. `local` is listed only
  when it is the default or enabled.

All new auth routes share the existing auth rate limiter.

## 2. Frontend

### Login screen (`/app/login`)
- Server component reads `/auth/methods`; on failure falls back to local only.
- Top: the default — email + password (local), username + password titled with the LDAP label
  (ldap), or a large "Continue with <label>" button (OIDC).
- Below an "or" divider: each alternative — password methods as a link that swaps the top
  form in place, OIDC providers as buttons.
- `?method=local` always renders the local form, enabled or not.
- Generic error messages unchanged; forced password change only for local accounts.

### BFF (Next)
- `POST /api/auth/ldap` → Go LDAP login; sets the same httpOnly session cookies as
  `/api/auth/login`.
- `GET /api/auth/oidc/[provider]/start?next=` → generates state, nonce, PKCE verifier;
  stores them with `provider` and `next` in an httpOnly, SameSite=Lax, 10-minute cookie;
  asks Go for the authorize URL; redirects.
- `GET /api/auth/oidc/callback?code=&state=` → state must match the cookie (else error page);
  calls Go exchange; sets session cookies; clears the state cookie; redirects to
  `erpPath(next)`. Provider errors (`?error=`) show the login page with a generic message.
- Callback URL to register at providers: `<erp_url>/api/auth/oidc/callback`; the BFF builds
  the same URL from the setting (never from the request's Host header).

### Settings → Authentication
New Settings hub card; page with: default method select + alternative checkboxes; LDAP section
(fields above, "LLDAP defaults" button, "Test connection"); OIDC providers list (add/remove,
fields above, callback URL shown read-only, "Test discovery"); group → role mapping table with
role picker; default role. Secrets are password inputs showing "stored" when set.
All strings translated (shell `.pot` + `fr.po`).

## 3. Testing
- **Go unit:** provisioning (link by subject; link by verified email; unverified email never
  links; different-subject relink refused; creation; role mapping replaces roles; default role;
  no role → refused; disabled user refused); LDAP flow against a fake `directory` (success,
  wrong password, unknown user, several matches, empty password, filter escaping); OIDC against
  an in-test fake provider (`httptest` discovery + JWKS + token endpoint: valid login; bad
  signature, wrong `aud`, expired, wrong nonce, PKCE mismatch → 401); settings (secrets
  encrypted at rest, never returned, empty secret keeps the stored one; validation).
- **Go integration (optional):** a real LDAP server only when `LDAP_TEST_URL` (+ bind
  credentials) is set — skipped otherwise; no LDAP container is added to compose.
- **App:** `/auth/methods` shape; LDAP login through real routes with a fake directory
  injected; OIDC exchange with the fake provider.
- **Frontend:** login screen per default/alternative combination and the `?method=local`
  fallback; BFF start/callback (state mismatch refused, `next` kept inside the ERP); settings
  form (secret fields write-only, mapping table).

## 4. Documentation
New `docs/adr/ADR-030-external-authentication.md` (why, flows with a Mermaid sequence for
OIDC, provisioning rules, security pitfalls); `CLAUDE.md` (`internal/auth/providers` bullet,
routes) and `core-front/CLAUDE.md` (login screen, BFF routes, settings page).

## Pitfalls to document
- Register the exact callback URL at each OIDC provider; host mode (ADR-025) means the ERP host.
- An IdP that doesn't send `email_verified` needs "trust email" to link existing accounts.
- Group mapping replaces manually assigned roles of provider-managed users at each login.
- Plain `ldap://` without StartTLS is refused outside loopback.
- Changing `master_key` makes stored secrets undecryptable — re-enter them.
- Local password stays reachable at `/app/login?method=local` even when hidden.
