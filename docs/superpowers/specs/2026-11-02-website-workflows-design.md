# Website workflows — design

Date: 2026-11-02 · Status: draft for approval

Six features, built and committed one at a time on `dev`, in this order. Together they let a
site designer build visitor journeys ("see an activity → log in or not → fill a form → book")
out of pages and buttons, and see those journeys as a map.

Decisions marked **(my call)** were made by Claude, not the user; everything else is the user's.

---

## 1. Remaining seats

**Why:** staff and visitors want to see at a glance how many places are left, and staff want to
filter/sort sessions by it (e.g. "sessions with fewer than 5 seats left").

- `event_session` gets a `remaining_seats` column = `capacity - seats_taken`, **stored in the
  database** so the generic list can filter, sort, aggregate and graph it.
- **(my call)** It is a Postgres generated column (`GENERATED ALWAYS AS (capacity - seats_taken)
  STORED`), added in the event module's `Migrate()` (idempotent). It can never drift from
  `seats_taken`. The ORM must not write it: add a `generated` struct-tag modifier
  (`db:"remaining_seats,generated"`) that excludes the column from INSERT/UPDATE/UPSERT and marks it
  read-only in the API — documented in `core/orm/README.md`. If the builder finds a lighter way the
  ORM already supports, it may use it, keeping "never written by application code".
- **ERP:** shown read-only in the session list and form and on the event form's sessions table;
  usable in search-bar filters, sort and Graph tiles.
- **Website:** the session picker (event booking block) and the event list cards show "N seats
  left" (the public API already returns `seats_left`; read it from the column instead of
  recomputing). Appointment slots already return per-slot `seats_left` from the slot computation
  (slots aren't stored) — show it on each slot in the slot picker too.
- Non-goal: changing how seats are captured (booking service stays the only writer of
  `seats_taken`).

## 2. Icons on the "Add block" menu

**Why:** the block menu is a plain text list; icons make block types recognisable.

- Each entry of the builder's **Add block** menu gets a Font Awesome icon (the library the app
  already uses, `byPrefixAndName`) beside its label. **(my call)** mapping: text → `align-left`,
  image → `image`, hero → `panorama`, record_list → `list`, record_detail → `file-lines`,
  record_carousel → `table-cells-large`, image_carousel → `images`, event_booking →
  `calendar-check`, appointment_booking → `clock`, event_list → `calendar-days`, section →
  `square`, form (feature 4) → `rectangle-list`. The builder may substitute an equivalent icon if
  one isn't in the loaded set.
- One map `BLOCK_ICONS: Record<BlockType, IconName>` next to `BLOCK_LABELS`, so a new block type
  can't be added without an icon (TypeScript enforces it).
- Non-goals: uploading logos, a media library, carousel changes.

## 3. Hours : minutes duration input

**Why:** typing "90" in "Slot length (minutes)" is error-prone; "1 h : 30 min" reads directly.

- On the **event form only** (not a general ERP widget), `slot_minutes` and `buffer_minutes`
  render as: a Font Awesome `clock` icon, an hours number box, ":", a minutes number box
  (`[🕐] [1] h : [30] min`).
- Stored value unchanged: total minutes in the same integer columns. Minutes box 0–59, any
  step; hours ≥ 0. Labels lose the "(minutes)" suffix.
- **(my call)** Implemented as a field widget (`widget: 'duration'` on the descriptor) in
  core-front's widget registry, since that's how descriptors pick inputs — but used only by these
  two event fields. Read-only display: "1 h 30 min".

## 4. Form block

**Why:** the site needs to collect data (contact requests, sign-ups, activity registrations) into
the ERP's own records, without code.

### What the designer does
- Adds a **Form** block. In its settings:
  - **Preset groups** to drop in, already mapped: *User data* (name, surname, email, phone) and
    *Address* (the 7-column address composite). **(my call)** "and else" → also *Message*
    (one long text). More presets can be registered later.
  - **Custom fields**: label, type (text, long text, email, phone, number, date, checkbox,
    select with options), required — each **mapped to an existing database column** of one of
    the form's target tables.
  - **Targets**: one or more tables the submission creates a record in (e.g. a `contact`, then a
    CRM lead). A target field can be bound to "the record created by an earlier target" (e.g.
    `crm.contact_id` ← the new contact), or to a fixed value (e.g. `crm.status = lead`).
  - **After submit** (per form): show a message (text set per form) or go to a chosen page.
  - **Login required** (boolean, default off) — see feature 5.
  - Submit button label.

### What happens on submit (server side)
- **(my call)** `POST /api/v1/website/forms/:page_id/:block_id` (anonymous or website token,
  the public rate limit). The server **reads the form's definition from the stored, published
  page layout** — never from the request — and writes only the mapped columns, all targets in
  one transaction; required/typed validation server-side; 422 with per-field errors.
- **Security boundary (my call):** a table can be a form target only if a module registers it in
  Go (`website.RegisterFormTarget(table, writableColumns…)`), the same "declare in code, publish
  as admin" shape as `WithPublicFields`. Initially: `contact` (name, surname, email, phone, address
  composite, company) and `crm`
  (name, company, phone, notes, status, contact_id). Saving a layout whose form maps a
  non-registered table/column is a 400 from the website module's layout validation. Anonymous
  visitors can never update existing records.
- **Contact data model (prerequisite, user-approved):** `contact` today has only name, email,
  company, status, kind. Add `surname`, `phone` and the 7-column address composite (same columns
  as `users`) — nullable, shown on the ERP contact form and descriptors, writable through generic
  CRUD. Existing contacts keep `name` unchanged (no split). `CreateWebsiteContact` copies the
  signup's surname/phone/address when present.
- **Logged-in visitor:** a `contact` target **reuses the visitor's own website contact**
  (updating only the fields the form maps) instead of creating a new one — that's the "join".
  The `users` row is **never** written by a form (it stays edited from My account only).
  Pre-fill: from the website contact, falling back to the account for any empty field.
- **Anonymous visitor** (login not required): the contact target goes through
  `contact.FindOrCreate` by email (as event bookings do). If that returns an **existing** contact,
  nothing on it is overwritten: later targets still link to it (e.g. `crm.contact_id`), and the
  values the visitor typed for the contact are posted as a `kind: "log"` chatter message on that
  contact ("Website form <page title>: phone …, address …"), so staff see them.
- **Create an account:** for anonymous visitors the form offers an optional checkbox +
  password. Ticked, the **signup runs first** (same rules as `/website/auth/signup`, 409 on an
  existing email → field error), the visitor is signed in, and the submission then proceeds as a
  logged-in one against the new website contact.
- **Bookings:** form answers are **not** attached to bookings in this version; a form is a
  separate step of a journey. (`event_booking` as a form target, through the booking service, is
  a later feature.)
- The new block type is added to both `BLOCK_TYPES` lists (Go `validate.go` and frontend
  `types.ts`, kept equal by the existing test).
- Non-goals: file upload fields, multi-step forms, a submissions inbox, email notifications on
  submit (can come later via mail templates).
- Needs a new ADR (ADR-033 "Website forms write into registered tables").

## 5. Login as a routable destination

**Why:** designers decide where in a journey visitors must log in — e.g. "Reserve" sends an
anonymous visitor to log in first, then on to a page the designer picked.

- **Link pickers:** every button/link setting in the builder (hero/image/section `cta_href`,
  image `href`, card detail pages) becomes a destination picker: a site page, or a **system
  page** — *Login*, *Sign up*, *My account* — or an external URL (free text, as today).
- Choosing *Login* or *Sign up* adds an **"After login, go to"** page picker (per button). The
  stored link is `/login?next=/<slug>`; the login and signup pages already honor `next`
  (must stay restricted to same-site paths).
- **Booking blocks** (event and appointment) and the **form block** get **Login required**
  (boolean, default off) and **After login, go to** (default: back to the same page/event). An
  anonymous visitor hitting a login-required block sees a "Log in to continue" button (plus
  "Sign up") instead of the form; logged in, booking/form fields are pre-filled from their
  account. Off: anonymous visitors complete it as today, with the optional account creation of
  feature 4.
- Non-goals: designing the login page itself in the builder (it stays the built-in page).

## 6. Workflow map (Website dashboard tile)

**Why:** with many pages and buttons, the designer needs to see the journeys and spot broken
ones.

- A tile on the **Website app dashboard** (`/website`), beside the existing count tiles, opening
  a full-width map.
- **Nodes:** every website page (title, `/slug`, published or not) plus the system pages
  (Login, Sign up, My account) and one "External" node per external host.
- **Edges:** derived from every page's layout — button/link destinations (feature 5), card
  detail pages (`detail_slug`), form "after submit" pages, login-required redirects ("after
  login") — labelled with the button label or block type. Edges through the login page show as
  page → Login → next page.
- **Editing:** dragging an edge's end onto another node re-targets that link (rewrites the source
  page's layout and saves it through the existing layout update). Clicking a node opens that page
  in the builder. **(my call)** Creating a brand-new link from the map is out of scope — links
  belong to blocks, so new ones are added in the builder.
- **Problems flagged** (red edge/node + a list beside the map): link to a page that doesn't exist,
  link to an unpublished page from a published one, unpublished page reachable from the menu,
  detail page lacking the matching detail/booking block **(my call: as a warning)**.
- **(my call)** Library: `@xyflow/react` (React Flow) with an automatic left-to-right layout;
  node positions are not persisted in v1.
- **(my call)** Edges are computed client-side from the pages' layouts (the editor already reads
  them through the staff API); no new backend route.

---

## Cross-cutting

- Each feature: tests (Go table-driven, Vitest), i18n msgids added to the module `.po`/`.pot`
  files (FR at least, as for existing strings), docs updated (CLAUDE.md sections for event,
  website; `core/orm/README.md` for `generated`; ADR-033), `make test` green, one commit on `dev`.
- Anti-goals: anonymous visitors writing anything the designer didn't map; visitors reaching
  another person's records through a form; a map that silently rewrites links the designer
  didn't drag.

## Left to the builder
Exact UI layout of the settings panels, icon substitutions, map styling, error message wording,
how presets are represented in block config, and test structure.
