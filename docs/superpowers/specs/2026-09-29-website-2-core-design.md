# Spec 2 — Website core

**Date:** 2026-09-29 · **Status:** implemented (see the deltas below and [ADR-025](../../adr/ADR-025-website-routing-and-erp-base-path.md)) · **Depends on:** [spec 1](2026-09-29-website-1-public-access-design.md)
· **Overview:** [website overview](2026-09-29-website-overview.md)

## Problem
Staff need to compose public pages from published data without writing code, preview them
exactly as visitors will see them, and choose whether the site and the ERP share one hostname
or use two.

## 1. Module `core/modules/website` (`type: go`, `app_mode: true`)
**`website_page`** (generic CRUD):
| Field | Notes |
|---|---|
| `slug` | unique per tenant (hand-written unique index); `""` = home page; `[a-z0-9-]` only |
| `title`, `seo_description` | |
| `published` | bool |
| `in_menu`, `menu_sequence` | site header menu |
| `layout` | JSON array of blocks |

Declares `WithPublicFields("slug","title","seo_description","in_menu","menu_sequence","layout")`
and seeds the selection `website.public.website_page = {fields: all, filter: {published: true}}`.

**Block** `{id, type, x, y, w, h, config}` — validated in a `website_page` Create/Update
override exactly like the Graph layout (`views.<entity>.graph`): unique ids, non-negative
geometry, non-zero `w`/`h`, `type` in the closed set, `config` opaque.

| type | config | Renders |
|---|---|---|
| `text` | `markdown`, `align` | rich text |
| `image` | `picture_id`, `alt`, `href` | image (pictures service) |
| `hero` | `title`, `subtitle`, `picture_id`, `cta_label`, `cta_href` | banner |
| `record_list` | `table`, `fields[]`, `filter`, `sort`, `page_size`, `display: grid\|list`, `detail_slug` | cards from `/public/:table` |
| `record_detail` | `table`, `fields[]` | one record; id from the URL |
| `event_booking` | `event_id` | spec 4 |
| `appointment_booking` | `event_id` | spec 4 |

A field referenced by a block but no longer in the effective set is skipped at render time.

## 2. Blocks package `core-front/packages/website-blocks`
One React component per block type plus a `config` schema per type (drives the side panel
form). Components are server-renderable and fetch through a `PublicDataSource` interface so the
same component runs on the public site (server `ApiClient` → `/api/v1/public`) and in the
editor (Server Action → same endpoint). This package is the single source of truth for how a
block looks — the editor preview and the public page cannot drift.

## 3. Editor (ERP side)
The `website_page` form gets a **Design** notebook page:
- `react-grid-layout` canvas, same pattern as Graph mode's edit mode (already a dependency):
  drag, resize, 12 columns, `verticalCompactor`.
- Palette to add blocks; side panel editing the selected block's `config`, with a
  **table › field** picker listing only `GET /api/v1/settings/website/public` effective sets.
- The canvas renders the real `website-blocks` components with live public data — the preview.
- Below the `md` breakpoint blocks stack by (`y`, `x`), both in the editor and on the site.
- Save = normal `PUT`; header button "View on site".

Website app menu: Pages · Events (spec 4) · Bookings (spec 4) · Website users · Published data ·
Outbox (spec 3) · Settings (routing).

## 4. Public rendering (`apps/shell/app/(site)`)
- Layout: header from `in_menu` pages ordered by `menu_sequence`, "Log in / My account",
  "ERP" link when an ERP session exists; footer from published `company` fields.
- `/` and `/<slug>` and `/<slug>/<id>` → RSC page fetching the page by slug, rendering blocks
  server-side (SEO), Next Data Cache tagged `website_page`. Unknown/unpublished slug → 404.
- `/login`, `/signup`, `/account` (website session).
- `generateMetadata` from `title`/`seo_description`.

## 5. Moving the ERP to `/app`
- `app/[...module]`, `app/page.tsx` (menu), `settings`, `appstore`, `print`,
  `force-password-change`, ERP `(auth)` → under `app/app/…`; ERP login becomes `/app/login`.
- Every internal `href`/`redirect`/`revalidatePath`, `requireAuth()`'s redirect target,
  `internal/reports` print URLs (`frontend_base_url` + path), tests, docs.
- `/database/management` and `/api/*` stay where they are.

## 6. Routing modes
Setting `website.routing` = `{mode: "path"|"host", site_host, erp_host}` (default `path`),
`PUT /api/v1/settings/website/routing` (`settings:website:write`), readable anonymously via
`GET /api/v1/public/website/routing` (mode + hosts only).

| mode | `site_host` / any host | `erp_host` |
|---|---|---|
| `path` | site at `/`, ERP at `/app` | — |
| `host` | site at `/`; `/app/*` → 308 to `https://<erp_host>/*` | `proxy.ts` rewrites `/x` → `/app/x`; `/` = ERP menu |

- `apps/shell/proxy.ts` reads the setting (cached 60 s in-process) and the `Host` header.
- **Lockout guard:** `PUT` with `mode: "host"` is rejected unless the request's Host equals
  `erp_host` (the BFF forwards it), proving the ERP hostname already resolves. Recovery override:
  env `EERP_SITE_ROUTING=path` on `core-front` forces path mode regardless of the setting.
- Cookies stay host-only; each hostname keeps its own sessions.

**nginx / certificates**
- `infra/nginx/nginx.conf`: `server_name _` already catches both hosts; ensure
  `proxy_set_header Host $host` and `X-Forwarded-Host` on the Next upstream.
- `infra/nginx/gen-certs.sh`: optional `SITE_HOST`/`ERP_HOST` env → one self-signed dev cert
  with `localhost` + both as SANs (regenerate by clearing the `gateway-certs` volume, as today).
- `infra/nginx/README.md`: production — DNS A/AAAA records for both hosts, then either mount
  your own cert/key into the volume or run certbot (webroot on `/.well-known/acme-challenge/`,
  served on :80 before the HTTPS redirect).

## Implementation deltas
- **Text block is plain text** (no markdown/HTML). **Image block** reads a record's picture anchor
  (`table`/`record`/`field`) through the public route `GET /api/v1/public/<table>/<id>/picture/<field>`
  (gated by the published scope). Record lists have **no sort** (the generic list has none).
- `website_page` optional columns are nullable (generic create requires non-pointer columns), so
  public JSON may carry `null` layout/published/in_menu; generic CRUD now maps unique violations to 409.
- ERP under `/app` via `erpPath()` (module paths stay module-relative); `/print`, `/api`, `/database` stay at root.
- Legacy bare ERP paths 308 to `/app` unless a **published** page owns that slug (proxy fetches published
  slugs + routing, cached 60 s, 2 s timeout, single in-flight fetch; slug set capped at 100 pages).
- Host mode is **redirects**, not rewrites: `erp_host` keeps `/app` and `/` goes to `/app`; unknown hosts
  behave like path mode. Host detection uses `Host` (nginx sets it). Lockout guard + `EERP_SITE_ROUTING=path`.
- Visitor pages `/login`, `/signup`, `/account`; the old ERP `/login` bookmark now 404s (ERP login is `/app/login`).
  Both sessions are cleared only on a Go 401.
- nginx overwrites `X-Forwarded-For` with `$remote_addr` and sets `X-Forwarded-Host` on every upstream.

## Testing
- Go: layout validation table test; slug uniqueness per tenant; public read of an unpublished
  page → 404.
- Front: block components render from a fake `PublicDataSource`; editor add/move/resize/config
  round-trip; `proxy.ts` rewrite matrix (mode × host × path) as a pure-function table test;
  every former route reachable under `/app`.

## Out of scope
Themes/custom CSS, multiple sites, page versioning/drafts, blog, forms builder.
