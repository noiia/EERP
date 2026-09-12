# ADR-012: Multi-company — several companies per tenant, company-scoped settings

**Status:** Accepted

## Context

Every workspace setting (`core/internal/settings`: default locale, number format,
Kanban/Calendar field config, picture sizes, the PDF reports letterhead/page-formats) was
scoped by `tenant_id` alone — one copy per tenant. `sale.invoice` re-entered the seller's own
name/address/phone/email on every single invoice, with its own doc comment flagging the gap:
"no workspace-wide company profile concept exists yet... `app_settings` would be the natural
home for one once multiple invoices need to share a single issuer identity."

The ask: let one tenant host several **Companies** (legal entities — French "société"), each
with its own copy of every workspace setting, switchable per user, with a shared
name/address/phone/email profile other features (starting with invoices) can read from
instead of duplicating.

**Deliberately not built here:** per-record data isolation. A company is *not* a second
tenancy dimension under the first — business tables (invoice, contact, crm, …) are untouched,
carry no `company_id`, and are not filtered by the active company. This ADR covers settings
scoping and a shared company-profile lookup only; see Consequences for exactly where that
line was drawn and why.

## Decision

### 1. `Company` is a plain generic-CRUD entity, not a dedicated-handler one

`core/modules/company` mirrors `core/modules/contact`'s shape exactly: `orm.Register[Company]()`,
free `GET/POST /api/v1/company` + `GET/PUT/DELETE .../:id`, permissions
`company:company:*` auto-derived from the route. No sensitive fields, no reason to take the
dedicated-handler path `internal/auth`'s users/roles use.

### 2. Active company is a per-user preference, not a JWT claim

Mirrors `preferred_locale` exactly: `Users.ActiveCompanyID *uuid.UUID`, set via
`UserRepository.SetActiveCompany`, read/written through the existing
`GET/PUT /api/v1/me/preferences` endpoint (extended, not duplicated) rather than a new one.
Switching company is instant — no token re-issue, no new `/auth/*` endpoint — the same
low-friction precedent locale-switching already established. The alternative (bake the active
company into the JWT, like `tenant_id`) would force a re-sign on every switch for no benefit,
since company scoping never needs to reach the ORM's tenant-style fail-closed WHERE-clause
layer (see Consequences).

### 3. Bootstrap is race-safe via a partial unique index, not a lock

`company.Repository.EnsureDefaultCompany` — the tenant's first company ("Default Company") is
created lazily, on first touch, via `INSERT ... ON CONFLICT (tenant_id) WHERE is_default DO
NOTHING` against a partial unique index (`uq_company_tenant_default`), the exact upsert idiom
`settings.Repository.Set`'s `(tenant_id, company_id, key)` already used. Two concurrent
first-touches for a brand-new tenant: the second blocks on the first's row lock, then
no-ops once it commits — no advisory lock, no `SELECT ... FOR UPDATE`. Proven with a real
concurrency test against a live Postgres (`core/internal/company/integration_test.go`,
`TestResolveActive_Bootstrap_ConcurrentFirstTouch`, 20 concurrent goroutines), not just
argued.

### 4. `app_settings` grows a `company_id` column; every existing settings key is threaded through it

`Repository.Get`/`Set` gained a `companyID` parameter (between `tenantID` and `key`); every
one of the six existing GET/PUT handler pairs in `internal/settings/handler.go` now resolves
`h.companies.ResolveActive(...)` once per request and threads `active.ID` through — a
mechanical, uniform change, not a per-key special case. The unique index moved from
`(tenant_id, key)` to `(tenant_id, company_id, key)`; `CompanyID` stays **nullable at the
schema level** even though the application layer always resolves a real one before use — a
backfill-then-`NOT NULL` migration wasn't worth the risk for a value every write already
provides. Pre-existing rows are backfilled once, eagerly, at boot
(`core/modules/settings/module.go`'s `Migrate()`, before the unique index swap, so uniqueness
is never briefly unenforced for a live column) — a tenant upgrading from before this shipped
sees its existing settings become its new default company's settings, nothing resets.

**Exempted on purpose:** brand colors (Settings → Global settings → Colors) stay a
client-only `useUiStore`/localStorage preference, untouched by company switching — they have
no server-side storage at all today, and moving them there was explicitly scoped out as a
separate, larger change.

### 5. Creating a company is a one-time deep copy, not an ongoing inheritance

`createCompanyAndActivate` (`apps/shell/src/lib/company.ts`) — a bespoke Server Action, not
the generic `createRecord`, since it's a 3-step sequence: (1) read the caller's **current**
active company (the clone source, captured *before* switching), (2) create the new company,
(3) `POST /api/v1/company/:id/clone-settings` (a new endpoint, `settings.Repository.
CloneCompanySettings`, one `INSERT ... SELECT ... ON CONFLICT DO NOTHING` copying every
row), (4) switch the caller into the new company. A later edit to either company's settings
never affects the other — this is a fork, not a fallback chain like
`report_page_format`'s override-cascade pattern.

### 6. `report_page_format` is company-scoped client-side only — a deliberately different enforcement level

Unlike `app_settings` (owned exclusively by `internal/settings`'s dedicated handlers),
`report_page_format` is reached through the fully generic CRUD surface, which has no
per-request "active company" context threaded through it. Its `CompanyID` column exists, and
the Settings → Global settings → Reports UI filters its list (`filter[company_id]=`) and
tags its create payload — but nothing enforces this server-side. This is *not* an oversight;
it's the same "no ORM-level second scoping column" boundary this ADR draws for business
tables generally (§Context), applied here because this table happens to be reached the same
way any other generic entity is.

### 7. Invoice fields fall back to the active company at PRINT time, not form-load time

`FieldFunction`/`OnChangeHandler` (`packages/core-front/src/views/behaviors.ts`) are
synchronous-only — no Promise support — which rules out seeding a *new invoice form's* issuer
fields from the active company (that needs a network fetch). Resolution instead happens
where the print route already resolves other cross-cutting context (`resolveReportChrome`,
ADR unrelated — docs/roadmaps/pdf-reports.md Phase 7): `ReportFieldNode` gained
`companyFallback?: 'name' | 'address' | 'phone' | 'email'`, a new pure helper
`reportCompanyFallbackFields()` collects opted-in leaves (mirrors `reportImageSources()`
exactly), and the print route fills in the active company's value **only when the record's
own value is empty** — additive, never a 404, same posture as every other chrome resolution
in that file. `sale.invoice`'s four issuer fields opt in;
its `Issuer*` DB columns and form fields are **untouched** — still editable, still
snapshotted on create. Removing them as redundant is explicitly deferred.

## Consequences

- **No `company_id` on any business table.** A user's view of contacts/invoices/CRM records
  is identical regardless of which company is active — multi-company here means "several
  settings profiles + a shared identity lookup," not "several isolated datasets." Building
  real per-record segregation later means doubling the ORM's tenant-scoping mechanism
  (`core/orm/internal/crud`'s hardcoded `tenant_id` WHERE-injection) across every table — a
  much larger, security-sensitive change, deliberately not attempted here.
- **`report_page_format`'s company scoping is client-enforced only** (§6) — a user with
  direct API access can see or create page formats across companies within their own tenant.
  Consistent with the business-table exemption above, not a regression from it.
- **No FK constraints** on `active_company_id`/`company_id` — matches this repo's existing
  convention (`Invoice.CustomerID` etc. have none either), app-layer-enforced.
- **A single atomic `Migrate()`** (add column, backfill, swap index, drop old index) is safe
  because this repo has no multi-replica rolling-deploy tooling today (confirmed via
  `main.go`/`compose.yml`). A real expand/contract split (add+backfill in one release, swap
  index in the next) would be needed if that changes.
- **`Invoice.Issuer*` cleanup is deferred.** The columns/form fields are live, editable, and
  still snapshot on create; only the *printed* value now prefers the active company when the
  invoice's own snapshot is blank. Removing them is a distinct, later pass once the
  print-time fallback is proven in real use.

## Reference implementation

`core/internal/company` (model + repository + bootstrap/race-safety), `core/modules/company`
(the Go module wrapper), `core/internal/settings` (the six-handler `companyID` threading +
`/me/preferences` extension + clone-settings endpoint), `apps/shell/app/settings/company/`
(hub tile → list → form) and `apps/shell/src/lib/company.ts` (the bespoke create-and-clone
Server Action) are the primary surfaces. `core/modules/sale/views/SaleViews.ts`'s four
`companyFallback`-tagged issuer fields are the first (so far only) consumer of §7.
