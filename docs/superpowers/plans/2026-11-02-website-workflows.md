# Website workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remaining seats on sessions, icons in the builder's block menu, an hours:minutes duration input, a website Form block writing into registered tables, login as a routable destination, and a workflow map of the site's pages and buttons.

**Architecture:** Go adds a DB-generated `remaining_seats` column (new ORM `generated` tag), contact person/address columns, a form-target registry and a form-submit endpoint that reads the form definition from the stored published page. The Next shell adds the block, link pickers and login gating, and a React Flow map page linked from the Website dashboard through a new generic `ViewDescriptor.dashboardLinks`.

**Tech Stack:** Go (Echo, custom ORM, Postgres 18), Next.js 16 App Router, React 19, MUI, Zustand, Vitest, `@xyflow/react` (new).

**Spec:** `docs/superpowers/specs/2026-11-02-website-workflows-design.md`

## Global Constraints

- One commit per feature, on `dev`, in order 1→6 (Feature 4 = Tasks 5–8, Feature 5 = Task 9, Feature 6 = Tasks 10–11); commit format `<type>(scope): …` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run commands with `rtk` where it has a filter; search with `rg`, never `grep`.
- `make test` green before each feature commit; `graphify update .` after code changes.
- Icons only through `byPrefixAndName.fas[...]` (add new names to `packages/core-front/src/views/icons.ts`); never import `fas` wholesale.
- Every user-facing string is a msgid: add it to the owning `.pot` and `fr.po` (shell: `apps/shell/i18n/`; module: `core/modules/<m>/i18n/`).
- Every new block type must appear in BOTH `core/modules/website/validate.go` `BlockTypes` and `core-front/apps/shell/src/website/types.ts` `BLOCK_TYPES` (`TestBlockTypes_MatchFrontend`).
- `seats_taken` stays written only by the booking service; `remaining_seats` is never written by application code.
- Anonymous visitors never update an existing record through a form; a form never writes `users`.
- Docs updated in the same feature commit: root `CLAUDE.md` (event, contact, website bullets), `core-front/CLAUDE.md` (Page editor / Public site / Field widgets rows), `core/orm/README.md` (generated), new `docs/adr/ADR-033-website-forms.md`.
- DB-backed Go tests: `testdb.Open(t)`, seed under a fresh `uuid.New()` tenant, clean only those rows.

## Review Focus

1. A form whose page is **unpublished** (or whose block id no longer exists) is submitted → 404, nothing written. Test in Task 7.
2. A form layout saved with a target table/column **not registered** (e.g. `users.password_hash`) → 400 at layout save, and the submit path re-checks it (a layout written before a module deregistered a column) → 422. Tests in Tasks 6 and 7.
3. `?next=` / "after login" slugs that are external, `//evil`, or ERP paths → dropped by `safeNext`, visitor lands on `/account`. Test in Task 9.
4. A session whose capacity is lowered or a booking cancelled → `remaining_seats` follows without any app write (generated). Test in Task 2.
5. Workflow-map drag re-targeting a link on a page whose layout another tab changed meanwhile → the map reloads the page's layout right before writing and rewrites only that one link. Test in Task 11.

---

### Task 1: ORM `generated` columns

**Files:**
- Modify: `core/orm/internal/cache/meta.go` (FieldMeta), `core/orm/internal/cache/cache.go:150` (tag parsing), `core/orm/query/insert.go:115` (`insertableColumns`), `core/orm/query/update.go:53` (`FromStruct`), `core/orm/internal/crud/repository.go:566,715` (generic `Update`, `orderedData`), `core/orm/migrate.go:16,88` (`MigrationField`), `core/internal/module/migration.go:166` (`ensureColumns`), `core/orm/internal/registry/registry.go:300` (ReadOnly), `core/orm/README.md`
- Test: `core/orm/internal/cache/cache_test.go`, `core/orm/query/query_test.go`, `core/orm/internal/registry/registry_test.go`

**Interfaces:**
- Produces: tag modifier `db:"col,generated"` → `FieldMeta.Generated bool`, `MigrationField.Generated bool`. Generated columns: excluded from INSERT/UPDATE/UPSERT column lists (typed and generic), never added by `ensureColumns` (the owning module's `Migrate()` adds them with their expression), API field `ReadOnly = true`; still selected/scanned/filterable/sortable.

- [ ] **Step 1: failing tests** — `TestParseTag_Generated` (`db:"remaining_seats,generated"` → `Generated == true`, Column `remaining_seats`); `TestInsert_SkipsGenerated` and `TestUpdateFromStruct_SkipsGenerated` (SQL from `query.Insert`/`query.Update(...).FromStruct` contains no `remaining_seats`); `TestRegister_GeneratedIsReadOnly` (registered table's API field `ReadOnly`); generic `crud.Repository.Update` given `{"remaining_seats": 3}` emits no SET for it.
- [ ] **Step 2:** `cd core && rtk go test ./orm/...` → FAIL.
- [ ] **Step 3:** implement as listed in Interfaces; README "Generated columns" section: why (derived values filterable without drift), how (`,generated` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS … GENERATED ALWAYS AS (…) STORED` in `Migrate()`), pitfall (struct field value after Create comes from RETURNING, never from the caller).
- [ ] **Step 4:** `rtk go test ./orm/... ./internal/module/...` → PASS.

### Task 2: `remaining_seats` (Feature 1)

**Files:**
- Modify: `core/modules/event/models.go:74` (EventSession), `core/modules/event/module.go:58` (Migrate), `core/modules/event/handler.go:45,98,160-185` (public sessions/upcoming read the column), `core/modules/event/views/EventViews.ts:80,195,204` (session form/list, event form's sessions table), `core-front/apps/shell/src/website/blocks/BookingForm.tsx:142-148`, `core-front/apps/shell/src/website/blocks/SlotPicker.tsx`, event `i18n/`, shell `i18n/`
- Test: `core/modules/event/module_test.go`, `core/modules/event/views/EventViews.test.ts`, `core-front/apps/shell/src/website/blocks/booking.test.tsx`

**Interfaces:**
- Consumes: Task 1's `,generated`.
- Produces: column `event_session.remaining_seats integer` = `capacity - seats_taken`; public JSON key stays `seats_left` (no client break).

- [ ] **Step 1: failing tests** — Go `TestRemainingSeats_Generated`: create session capacity 10, book 3 seats through the booking service → row `remaining_seats == 7`; staff PUT capacity 5 → `2`; cancel → `5`; generic `GET /api/v1/event_session?order=remaining_seats&lt[remaining_seats]=6` returns it. Vitest: session list + form descriptors contain `{ name: 'remaining_seats', readOnly: true }` labelled `'Remaining seats'`; sessions table columns include `{ key: 'remaining_seats', label: 'Remaining seats' }`; `BookingForm` renders `3 seats left` for a choice with `seatsLeft: 3`, `Full — join the waiting list` at 0; `SlotPicker` slot label shows `2 seats left`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** `RemainingSeats int `db:"remaining_seats,generated" json:"remaining_seats"``; Migrate: `ALTER TABLE event_session ADD COLUMN IF NOT EXISTS remaining_seats integer GENERATED ALWAYS AS (capacity - seats_taken) STORED` + `CREATE INDEX IF NOT EXISTS idx_event_session_remaining_seats ON event_session (remaining_seats)`. Public handlers select `remaining_seats` instead of computing. Site labels: `${n} ${t('seats left')}` (msgid already exists in EventList).
- [ ] **Step 4:** `make test` → PASS. Update root CLAUDE.md event bullet.
- [ ] **Step 5: commit** `feat(event): remaining seats per session, stored and shown on the site`.

### Task 3: Block menu icons (Feature 2)

**Files:**
- Modify: `core-front/apps/shell/app/app/website/pages/[id]/design/BlockPalette.tsx`, `core-front/packages/core-front/src/views/icons.ts`
- Test: `core-front/apps/shell/app/app/website/pages/[id]/design/BlockPalette.test.tsx` (create)

**Interfaces:**
- Produces: `export const BLOCK_ICONS: Record<BlockType, string>` (icon names) next to `BLOCK_LABELS`; Task 8 adds `form: 'rectangle-list'`.

- [ ] **Step 1: failing test** — every `BLOCK_TYPES` entry has `BLOCK_ICONS[type]` and `byPrefixAndName.fas[BLOCK_ICONS[type]]` is defined; opening "Add block" renders one `svg` per menu item.
- [ ] **Step 2:** FAIL. **Step 3:** mapping per spec §2 (`align-left, image, panorama, list, file-lines, table-cells-large, images, calendar-check, clock, calendar-days, square`); `ListItemIcon` in each `MenuItem`. **Step 4:** PASS + lint.
- [ ] **Step 5: commit** `feat(website): icons on the builder's Add block menu`.

### Task 4: `number/duration` widget (Feature 3)

**Files:**
- Modify: `core-front/packages/core-front/src/views/descriptor.ts:100` (add `'duration'` to `number`), `core-front/packages/core-front/src/views/widgets.tsx` (component + `'number/duration'` entry), `core/modules/event/views/EventViews.ts:64,66`, event + engine `i18n`, `core-front/CLAUDE.md` Field widgets row
- Test: `core-front/packages/core-front/src/views/widgets.test.tsx`, `core/modules/event/views/EventViews.test.ts`

**Interfaces:**
- Produces: `NumberDurationWidget` — value = integer minutes; renders clock icon, hours input, `h`, `:`, minutes input (0–59), `min`.

- [ ] **Step 1: failing tests** — value `90` shows hours `1`, minutes `30`; typing hours `2` → `onChange(150)`; minutes `75` clamps to `59`; both emptied → `onChange(null)`; disabled/read-only renders text `1 h 30 min`; `svg` present. Descriptors: `slot_minutes`/`buffer_minutes` have `widget: 'duration'`, labels `'Slot length'` / `'Buffer between slots'`.
- [ ] **Step 2:** FAIL. **Step 3:** implement; hours `min 0`, integer. **Step 4:** `make test` PASS.
- [ ] **Step 5: commit** `feat(event): hours and minutes input for slot length and buffer`.

### Task 5: Contact person + address columns

**Files:**
- Modify: `core/modules/contact/internal/contacts.go` (Contact), `core/modules/contact/website.go:25` (`CreateWebsiteContact`), `core/internal/app` wiring of `OnWebsiteSignup`, `core/modules/contact/views/*` (form: surname, phone, `type: 'address', name: 'address'`), contact `i18n/`
- Test: `core/modules/contact/module_test.go`, contact views test

**Interfaces:**
- Produces: contact columns `surname`, `phone` (text, nullable via `*string`) and `address_number *int`, `address_complement|street|zip_code|city|state|country *string` (same names as `users`). `CreateWebsiteContact(ctx, ex, tenant uuid.UUID, p WebsiteContact) (uuid.UUID, error)` with `type WebsiteContact struct{ Name, Surname, Email, Phone string }` (replaces the name/email signature; update callers).

- [ ] **Step 1: failing tests** — generic POST/GET contact round-trips the new columns; signup with name "Ann" creates a contact whose `surname`/`phone` mirror the user row; existing contact rows keep `name` untouched after `Migrate`.
- [ ] **Step 2–4:** FAIL → implement → `rtk go test ./modules/contact/... ./internal/app/...` PASS. (Committed with Feature 4.)

### Task 6: Form targets registry + layout validation

**Files:**
- Create: `core/internal/website/forms.go`, `core/internal/website/forms_test.go`
- Modify: `core/modules/contact/module.go` & `core/modules/crm/module.go` (`Register()` calls), `core/modules/website/validate.go` (validate `form` blocks), `core/modules/website/validate_test.go`

**Interfaces:**
- Produces:
  - `website.RegisterFormTarget(table string, columns ...string)`; `website.FormTarget(table string) (cols map[string]bool, ok bool)`.
  - Registered: `contact`: name, surname, email, phone, company, address_number…address_country; `crm`: name, company, phone, notes, status, contact_id.
  - `website.FormConfig` (Go mirror of the TS type in Task 8), parsed from block `config`:
    ```go
    type FormConfig struct {
        Targets       []FormTargetSpec `json:"targets"`
        Fields        []FormField      `json:"fields"`
        LoginRequired bool             `json:"login_required"`
        AllowSignup   bool             `json:"allow_signup"`
        After         FormAfter        `json:"after"` // {kind: "message"|"page", message, slug}
        AfterLogin    string           `json:"after_login_slug"`
        SubmitLabel   string           `json:"submit_label"`
    }
    type FormTargetSpec struct { Table string `json:"table"`; Links map[string]int `json:"links"`; Fixed map[string]string `json:"fixed"` }
    type FormField struct { ID, Label, Type, Column string; Required bool; Options []string; Target int; Preset string }
    ```
    `Type` ∈ text|long|email|phone|number|date|checkbox|select|address (address: `Column` is the prefix, writes the 7 columns). `Links[col] = i` binds `col` to the id created by target `i < this index`.
  - `ValidateFormConfig(FormConfig) error` — ≥1 target, every table registered, every field/link/fixed column registered for its target, link index earlier than its target, unique field ids, select has options, at most 10 targets / 60 fields.
- [ ] **Step 1: failing tests** — table-driven `TestValidateFormConfig` (ok contact+crm with `links: {contact_id: 0}`; unregistered table; unregistered column `users.password_hash`; forward link; duplicate id; select without options). `validate_test.go`: saving a layout with a bad form block → 400.
- [ ] **Step 2–4:** FAIL → implement (`form` added to `BlockTypes`) → PASS.

### Task 7: Form submit endpoint

**Files:**
- Create: `core/internal/website/formsubmit.go`, `core/internal/website/formsubmit_test.go`
- Modify: `core/internal/app/app.go:~910` (mount), `core/internal/app/website_test.go`

**Interfaces:**
- Consumes: Task 6 registry/`FormConfig`; `contact.FindOrCreate`, `contact.WebsiteContactID`; `internal/chatter` repository for the log message.
- Produces: `POST /api/v1/website/forms/:page_id/:block_id` (group: public rate limit + `TenantMiddleware(siteTenant)` + `OptionalWebsiteJWTMiddleware`), body `{values: {<field id>: any}}` → `201 {ok: true}`; `422 {error:{code:"VALIDATION_ERROR", fields:[ids]}}`; `401` when `login_required` and anonymous; `404` page unpublished / block missing / not a form.
- Also produces (used by Task 8): `GET /api/v1/website/me/contact` (website group, `WebsiteJWTMiddleware`) → the visitor's website contact as `{name, surname, email, phone, address_*}` (404 when none); `GET /api/v1/settings/website/form_targets` (staff, `settings:website:read`) → `{data: [{table, columns: string[]}]}` from the registry, sorted.
- Behavior: load `website_page` by id, tenant, `published = true`; find block; `ValidateFormConfig` again; validate values per type (email `net/mail`, number parse, date `YYYY-MM-DD`, select ∈ options, checkbox bool, required non-empty, text ≤ 2000); one transaction writing targets in order:
  - target `contact` + signed-in visitor → `WebsiteContactID(email of token user)`; UPDATE only mapped columns; id = that contact (none found → create with `website = true`).
  - target `contact` + anonymous → `FindOrCreate(name, email)`; if it existed before (check via a pre-select inside the tx), write nothing to it and post a chatter `kind: "log"` on it: `Website form "<page title>": <label>: <value>; …` (author email = the submitted email); if new, UPDATE the mapped columns on it.
  - other tables → INSERT mapped + fixed + linked columns, `tenant_id` = site tenant.
- [ ] **Step 1: failing tests** (DB-backed, `internal/app` style) — `/me/contact` returns the signed-in visitor's contact and 403s an ERP token; `form_targets` lists contact and crm; anon contact+crm → new contact + crm with `contact_id`; anon existing email → contact unchanged, chatter log on it, crm linked; signed-in → own website contact phone updated, no new contact, `users` row unchanged; `login_required` anon → 401; unpublished page → 404; missing required → 422 `fields: ["email"]`; value for an unmapped key ignored.
- [ ] **Step 2–4:** FAIL → implement → PASS.

### Task 8: Form block (frontend) — Feature 4 commit

**Files:**
- Modify: `core-front/apps/shell/src/website/types.ts` (`'form'`, `FormConfig` TS mirror of Task 6), `BlockPalette.tsx` (label `'Form'`, icon `rectangle-list`), `BlockSettings.tsx` (`case 'form'`)
- Create: `core-front/apps/shell/app/app/website/pages/[id]/design/FormSettings.tsx` (+test), `core-front/apps/shell/src/website/blocks/FormBlock.tsx` (server: prefill), `core-front/apps/shell/src/website/blocks/SiteForm.tsx` (client) (+`form.test.tsx`), `core-front/apps/shell/app/api/site-forms/[page]/[block]/route.ts` (+test), `listFormTargets` Server Action in `src/website/editor-actions.ts` (over Task 7's `form_targets` route), `docs/adr/ADR-033-website-forms.md`, docs
- Test: as listed

**Interfaces:**
- Consumes: Task 7 endpoint; Task 5 contact columns; existing `/api/site-auth/signup` BFF (sets site cookies).
- Produces: `FormConfig` TS type; `FORM_PRESETS: Record<'user'|'address'|'message', (target: number) => FormField[]>` — user: name(text, req), surname(text), email(email, req), phone(phone) on contact columns; address: one `address` field prefix `address`; message: `long` → crm `notes` if a crm target exists else contact not allowed (preset disabled without a crm target).
- Editor: targets list (table select from `listFormTargets`, link select "← record of target N" per uuid-ish column ending `_id`, fixed values), presets buttons, custom field rows (label, type, required, options, target, column select from that target's registered columns), After submit (message text | page picker from `listEditorPages`), Login required switch, After login page picker, Allow account creation switch (hidden when login required), submit label.
- Site: `FormBlock` resolves identity (`getSiteIdentity`/`getWebsiteMe`) for prefill (website contact first, account fallback — read via Task 7's `GET /api/v1/website/me/contact`); login required + anon → `Log in to continue` button to `/login?next=<after_login or current path>` + `Sign up` link; else `SiteForm`. `SiteForm` posts to `/api/site-forms/:page/:block`; with "Create an account" ticked it first POSTs `/api/site-auth/signup` {email, password, name} (409 → field error on email), then submits; success → message or `router.push('/'+slug)`.
- [ ] **Step 1: failing tests** — FormSettings: adding the User data preset adds 4 fields targeting contact; column select lists only registered columns. SiteForm: required empty blocks submit with field error; success shows configured message; page redirect pushes `/thanks`; signup-first order (signup mock called before submit mock); login-required anon renders link `/login?next=%2Fbook`. Route: forwards site token when present, never the ERP one.
- [ ] **Step 2–4:** FAIL → implement → `make test` PASS. ADR-033 (why registered targets, server-read definition, contact rules, chatter fallback); CLAUDE.md website + core-front Public site/Page editor rows.
- [ ] **Step 5: commit** (Tasks 5–8) `feat(website): form block writing into registered tables`.

### Task 9: Link destinations + login-required booking (Feature 5)

**Files:**
- Create: `core-front/apps/shell/app/app/website/pages/[id]/design/LinkPicker.tsx` (+test), `core-front/apps/shell/src/website/links.ts` (+test)
- Modify: `BlockSettings.tsx` (replace `text('cta_href')`, `text('href')` with `LinkPicker`; booking blocks get `login_required` switch + `after_login_slug` picker), `types.ts` (`HeroConfig.cta_next?`, `ImageConfig.href_next?`, `BookingConfig.login_required?`, `after_login_slug?`), `blocks/HeroBlock.tsx`/`ImageBlock.tsx`/`SectionBlock.tsx` (build href via `links.ts`), `blocks/EventBookingBlock.tsx`/`AppointmentBookingBlock.tsx` (gate), `src/website/urls.ts` (`safeNext` reuse)
- Test: as listed + `booking.test.tsx`, `blocks.test.tsx`

**Interfaces:**
- Produces: `export const SYSTEM_PAGES = { login: '/login', signup: '/signup', account: '/account' } as const`; `linkHref(href: string, next?: string): string | undefined` → for `/login`/`/signup` with `next` a page slug returns `/login?next=%2F<slug>`, else `safeHref(href)`; `LoginGate({ next }: { next: string })` server component (Log in / Sign up buttons) shared with Task 8's FormBlock.
- LinkPicker: select of "Site page" (pages list), "Login", "Sign up", "My account", "External link" (text, `safeHref`-validated); Login/Sign up reveal "After login, go to" page select (default: none = `/account`).
- [ ] **Step 1: failing tests** — `linkHref('/login', 'book')` = `/login?next=%2Fbook`; `linkHref('/login', '//evil')` = `/login`; `linkHref('javascript:x')` undefined; LinkPicker round-trips each kind; booking block with `login_required` + no identity renders `LoginGate` linking `/login?next=%2F<after_login_slug or current slug/id>`; with identity renders `BookingForm` with defaults.
- [ ] **Step 2–4:** FAIL → implement → `make test` PASS; core-front CLAUDE.md Page editor row.
- [ ] **Step 5: commit** `feat(website): login and signup as link destinations, login-required booking`.

### Task 10: Workflow graph model

**Files:**
- Create: `core-front/apps/shell/src/website/workflow.ts` (+`workflow.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  type NodeId = `page:${string}` | 'sys:login' | 'sys:signup' | 'sys:account' | `ext:${string}` // page:<slug>, ext:<host>
  interface WfNode { id: NodeId; label: string; slug?: string; pageId?: string; published?: boolean; inMenu?: boolean; missing?: boolean }
  interface WfEdge { id: string; from: NodeId; to: NodeId; label: string; pageId: string; blockId: string; key: LinkKey }
  type LinkKey = 'cta_href' | 'href' | 'detail_slug' | 'after.slug' | 'after_login_slug' | 'cta_next' | 'href_next'
  interface WfProblem { level: 'error' | 'warning'; message: string; nodeId?: NodeId; edgeId?: string }
  buildWorkflow(pages: { id: string; slug: string; title: string; published: boolean; in_menu: boolean; layout: Block[] }[]): { nodes: WfNode[]; edges: WfEdge[]; problems: WfProblem[] }
  retarget(layout: Block[], blockId: string, key: LinkKey, to: NodeId): Block[]
  ```
- Rules: a login link with `next` → two edges (page→sys:login labelled button, sys:login→next page labelled "after login"); login-required booking/form → page→sys:login + sys:login→after-login page; target slug with no page → node `missing: true` + error "Link to a page that doesn't exist"; published→unpublished edge → warning; `in_menu` unpublished page → warning; `detail_slug` target lacking a `record_detail`/booking block → warning.
- [ ] **Step 1: failing tests** — one per rule above with literal fixtures; `retarget` changes only the named block/key (other blocks deep-equal), and for `cta_href` to `sys:login` keeps existing `cta_next`.
- [ ] **Step 2–4:** FAIL → implement → PASS.

### Task 11: Workflow map page + dashboard link (Feature 6)

**Files:**
- Modify: `core-front/packages/core-front/src/views/descriptor.ts` (`ViewDescriptor.dashboardLinks?: { title: string; description?: string; icon?: string; path: string }[]`), `renderers.tsx:1374` (render them as tiles after the counts, `IntentLink` to `erpPath(path)`), `core/modules/website/views/WebsiteViews.ts` (dashboard `dashboardLinks: [{ title: 'Workflows', description: 'Pages and the buttons between them', icon: 'diagram-project', path: '/website/workflows' }]`), `core-front/apps/shell/package.json` (`@xyflow/react`, pinned exact version), `views/lazy-widgets.tsx`-style lazy import for the map
- Create: `core-front/apps/shell/app/app/website/workflows/page.tsx` (server: `requireAuth('/website/workflows')`, module active check, loads pages with layouts via staff API), `WorkflowMap.tsx` (+test), shell `i18n`
- Test: renderers test for `dashboardLinks`; `WorkflowMap.test.tsx`

**Interfaces:**
- Consumes: Task 10 `buildWorkflow`/`retarget`; existing `saveLayout(pageId, layout)` Server Action (`src/website/editor-actions.ts`).
- Map: React Flow, left-to-right auto layout (BFS depth from the home page `slug ''`, rows by order), node click → `router.push(erpPath('/website/pages/<id>/design'))` (system/external nodes not clickable), edge end drag (`onReconnect`) → re-fetch that page's layout, `retarget`, `saveLayout`, rebuild; error shows as `ViewBanner` error and the edge snaps back. Problems list beside the map (below it under `md`), each item highlighting its node/edge.
- [ ] **Step 1: failing tests** — dashboard renders a "Workflows" tile linking `/app/website/workflows`; WorkflowMap renders a node per page + system nodes; clicking a page node pushes the design path; reconnect calls `saveLayout` with the retargeted layout built from the freshly fetched one (Review Focus 5); a failed save shows the error banner and keeps the old edge; problems list shows the missing-page error.
- [ ] **Step 2–4:** FAIL → implement → `make test` PASS; core-front CLAUDE.md (Page editor row + View types `dashboardLinks`).
- [ ] **Step 5: commit** `feat(website): workflow map of pages and buttons on the Website dashboard`.
