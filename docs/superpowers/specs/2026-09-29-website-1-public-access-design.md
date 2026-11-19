# Spec 1 — Public access and website identities

**Date:** 2026-09-29 · **Status:** implemented (aligned with the build; see ADR-024 Implementation notes) · **ADR:** [ADR-024](../../adr/ADR-024-public-access-and-website-identities.md)
· **Overview:** [website overview](2026-09-29-website-overview.md)

## Problem
Every EERP route requires an ERP JWT plus a derived `module:resource:action` permission. A
public website needs (a) anonymous reads of a narrow, admin-controlled slice of data, and
(b) self-registered visitor accounts that can never reach the ERP.

## 1. Declaring and publishing public fields
**Module side — the ceiling.** New register option beside `WithFieldGroups`:

```go
orm.Register[ProductVariant](orm.WithPublicFields("product_id", "name", "unit_price"))
```

It fills `TableMeta.PublicFields []string`. Names are not validated (picture anchors aren't columns). A table without the option can never be public. `id` is always
implicitly public for a published table (needed for detail links).

**Admin side — the selection.** `app_settings` key `website.public.<table>`, at `company_id = uuid.Nil` (site-wide slot):

```json
{ "fields": ["name", "unit_price"], "filter": { "published": true } }   // e.g. for `event`: filter hides drafts
```

- `fields` must be a subset of `PublicFields` — `PUT` rejects anything else with 400.
- `filter` is an optional exact-match row scope (same semantics as `filter[col]=`), columns
  validated against the table meta. It is AND-ed server-side with every public query and cannot
  be overridden by the caller.

**Effective set** = `PublicFields ∩ published.fields` (+ `id`). Computed per request from the
settings store (cached with the settings read path).

**Endpoints** (permissions `settings:website:read`/`write`, route-derived):
- `GET /api/v1/settings/website/public` — every table with `PublicFields`, its declared fields,
  and the current selection; feeds the "Published data" page.
- `PUT /api/v1/settings/website/public/:table` — replace one table's selection.

## 2. Public read API
Route group `/api/v1/public`, mounted without `jwtMw`/`permMw`, rate-limited at `public_rate_limit_per_minute` (default 300); resolver wrapped by `ActiveOnly` so deactivated modules' tables 404.

- `GET /api/v1/public/:table` — the generic list handler (page/page_size, filter, search, in,
  range, distinct; no sort param exists) with the effective set as its column whitelist.
- `GET /api/v1/public/:table/:id` — one record, subject to the same forced `filter`.

**Tenant.** New config field `website_tenant_id`. Empty → the database's single tenant; if more
than one tenant exists and it is empty, the public group is not mounted and boot logs a warning
(same "absent config ⇒ not mounted" posture as pictures). Stamped with `access.WithTenant`.

**Enforcement** reuses the ADR-013/014 machinery rather than a parallel check: the handler
builds a synthetic group set so `checkColumn` accepts only effective-set columns and
`BuildResponse` omits every other key. Concretely, the public handler passes an
`access.WithColumnAllowlist(ctx, set)` value that both functions consult before group gating;
it is only ever set by the public group.

**Rules**
- Table not published (empty selection or no `PublicFields`) → **404**, never an empty list,
  so tables cannot be enumerated.
- Any param naming a non-effective column → 400 (same message as an unknown column).
- Relations: a many2one value is its raw id, returned only if the column itself is published; labels are the consumer's job (no transitive exposure).
- **Pictures:** the public picture route is not in this plan; it moves to spec 2 (first consumer).
- `aggregate` is not offered on the public group in v1.
- Responses go through the Redis read cache as usual; public reads are the hottest path.

## 3. Website identities
**JWT audience.** New claim `aud` (`erp` | `website`); a missing claim reads `erp`, so every
existing token stays valid. `JWTMiddleware` rejects `aud=website` with 403 on every route except
the `/api/v1/public/*` and `/api/v1/website/*` groups. The rejection lives in the middleware, not
in roles, so a mis-granted role cannot open the ERP to a website token.

**Users.** `users` gains `kind` (`internal` default | `website`) and `email_verified_at`
(nullable; used by spec 4).
- ERP login (`/api/v1/auth/login`) refuses `kind=website`; website login refuses
  `kind=internal` — same generic "invalid credentials" error, no account enumeration.
- Settings → Users lists `kind=internal` only; the Website app lists `kind=website` through a
  dedicated handler (`GET /api/v1/website_admin/users` + partial `PUT …/:id`, underscored so the permission derives; no GET `:id`) — edit
  profile, lock/unlock (soft delete + refresh revocation), no role assignment (website users always hold exactly `website_user`).

**Routes** (group `/api/v1/website`, rate-limited):
| Route | Auth | Purpose |
|---|---|---|
| `POST /website/auth/signup` | none | email, password, name → creates a `kind=website` user with role `website_user`, returns tokens with `aud=website` |
| `POST /website/auth/login` / `refresh` / `logout` | none / refresh cookie | mirrors ERP auth, `aud=website` |
| `GET\|PUT /website/me` | website token (`WebsiteJWTMiddleware`) | own profile |

**Roles** seeded per tenant (deterministic ids, `internal/auth/seed.go`):
| Technical name | Held by | Permissions |
|---|---|---|
| `website_anonymous` | nobody (documents the anonymous surface) | none — access comes only from the public group |
| `website_user` | every `kind=website` user | none on the ERP; website routes check the `aud` + the user id |
| `website_admin` | internal users, assigned in Settings → Users | `website_page:*`, `event*:*`, `settings:website:*`, `website_admin_users:*`, outbox read |

**Frontend.** Website session in two httpOnly cookies `eerp_site_access`/`eerp_site_refresh`, managed by BFF routes `/api/site-auth/*`, independent of the ERP session.

## 4. Initial declarations
- `warehouse`: `product` (name, reference, unit, unit_price, + a new `description` text column),
  `product_variant` (product_id, name, unit_price). A variant's `unit_price` is nullable
  ("inherit the product's") — the `record_list`/`record_detail` blocks show the product's
  `unit_price` when the variant's is null and `product.unit_price` is published.
- Pictures: product/variant images use the existing picture service (a `boolean/picture` widget
  field), so they need the public picture route in §2.
- `company`: name, address fields, phone, email (site footer).
- `website_page` and `event*` declare theirs in specs 2 and 4.

## Testing
- Whitelist: for each param (filter/search/in/gt…/sort/distinct) on a declared-but-unpublished
  and on an undeclared column → 400; response keys ⊆ effective set.
- Forced `filter`: a `published=false` row is invisible to list and to `/:id`.
- Unpublished table → 404.
- `app_test` sweep: every non-public route in the route table answers 403 to an `aud=website`
  token.
- Login cross-refusal both ways.

## Out of scope
Email verification (spec 4), social login, password reset by email (follow-up once spec 3 lands).

## Implementation deltas
See ADR-024 "Implementation notes": case-insensitive unique live email (boot precondition, 409 on collision), site-tenant resolved at boot, publish-from-site-tenant pitfall, IP-keyed rate limiter behind the gateway.
