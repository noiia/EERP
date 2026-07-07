# Conventions (contracts — source of truth)

These are the stable contracts every part of the EERP frontend (engine, Next host, and business
modules) must honor. This file is the single source of truth; point Claude Code at it when
implementing any task.

The frontend is a **standalone Next.js service** (App Router, RSC/SSR). It runs as its own process
and talks to the Go backend **only over HTTP** (a BFF boundary). The server owns data, caching,
session, and authorization; **Zustand** owns client interaction + UI state.

| Concern | Contract |
| --- | --- |
| Backend base URL | `{API_BASE}/api/v{API_VERSION}` — **server-side env** (`API_BASE`, `API_VERSION`, default `1`). Never exposed to the browser; the browser calls Next, Next calls Go. |
| Module routes (Go) | `/{module}/` (list, create) + `/{module}/{id}` (get, update, delete). CRM contacts → `/crm/` + `/crm/{id}` |
| Core routes (Go) | `GET /health`, `GET /ready`, `GET /modules` |
| Auth (Go) | `POST /auth/login {email, password}`; `POST /auth/refresh` |
| Session transport | **BFF**: Next exchanges credentials with Go, stores the token in an **HttpOnly cookie on the Next domain**, and resolves identity **server-side** (`next/headers` `cookies()`). The token never reaches client JS. The client holds only a non-secret **session mirror** (identity + permissions) for UI gating. |
| Token TTLs | access **1h**, refresh **7d**, refresh **single-use** (rotation). Reusing a spent refresh = theft → Go kills session → Next clears the cookie → redirect to `/login`. |
| Error envelope (Go) | `{ "error": { "code": "UPPER_SNAKE", "message": "...", "request_id": "01J..." } }` |
| Status map | 400 validation · 401 unauthenticated · 403 forbidden · 404 not found · 409 conflict · 500 `INTERNAL_ERROR` |
| Permissions | DSL `module:resource:action` (`crm:contacts:` then `read` / `write` / `delete`). Wildcards `*:*:read`, `crm:*:read`. **Server** authorizes (RSC/route guard); **client** `<Can>` gates UI off the session mirror. |
| Delete | Soft-delete by default (ADR-003). `remove` archives; add `restore` when backend exposes it. |
| View types (v1) | `form`, `tree`, `dashboard`. New entity = a descriptor; new view type = one store factory + one renderer + one server loader path. |
| Data + mutations | **Reads** server-side via the server `ApiClient` (Next Data Cache, `tags:[entity]`). **Writes** via Server Actions that call Go then `revalidateTag(entity)` — no client→Go calls. |
| **Module FE contract** | `module.json.static_files.views` lists `.ts` files under the module's `views/`. Each file default-exports a **`FrontModule`** ( `{ name; routes:[{ path; descriptor: ViewDescriptor; permission? }] }` ) registered with the engine. A module contributes **descriptors only** — the engine derives the server loader, the Zustand store, and the renderer. Modules import the engine from `@eerp/core-front`. `module.json.app_mode: true` additionally presents the module as an application (landing-menu tile); default = routes only, no tile. |
| **i18n contract** | Gettext, **source string = msgid**: components call `useT()` / `t('Save')`; untranslated strings render verbatim. A module ships translations in an **`i18n/` folder** next to its `module.json` — `<name>.pot` (declared source strings) + one `<locale>.po` per language (`fr.po` → locale `fr`); the shell's own chrome strings live in `apps/shell/i18n/`. Discovered with the modules at **build time** (no module.json field — the folder is the contract), parsed to JSON, registered into the shared `translationRegistry`; catalogs of the same locale **merge across modules** (last registered wins per msgid). The user's language choice + enabled translations persist client-side in `useI18nStore` (Settings → Translations). Settings → Translations also **exports** one drop-in `.po` per module for a chosen target language (every translatable msgid, existing msgstrs pre-filled, blanks otherwise — `renderModulePo`). No plurals/msgctxt (such entries are skipped). |

## Module discovery (build-time, shared config)

At **build time** the frontend reads the **shared `eerp-config.json` at the repo root** (`EERP/` — the
same file the Go backend uses) and walks each path in its `module_root` array. For each it finds
`module.json`, reads `static_files.views`, and resolves each to `<module_dir>/views/<file>`. Reusing
the backend config keeps a single source of truth for module roots. The read happens **at build time
only** — the running frontend service never reads the backend's config or filesystem at runtime, so
the BFF boundary still holds.

The same walk discovers each module's **`i18n/` folder** (if any): every `<locale>.po` is parsed to
JSON at build time and written into a generated manifest that registers it with the engine's
`translationRegistry` — the browser never ships a gettext parser. Adding a language to a module is
dropping a `.po` file in its `i18n/` folder and rebuilding; no declaration anywhere else.

## State model (server vs client)

- **Server owns:** data fetching, the Next Data Cache, the session (httpOnly cookie → identity
  resolved server-side), and authorization.
- **Client (Zustand) owns:** per-view interaction stores seeded from server `initialData` (records,
  selected, draft, dirty, expanded); a `useSessionStore` (`persist`) mirroring identity/permissions
  for UI gating; a `useUiStore` (`persist`) for theme/sidebar/last-route; a `useI18nStore`
  (`persist`) for the active language + enabled translations. No `useSyncExternalStore`
  controller layer.
- **Mutations:** Server Actions → Go → `revalidateTag` → server re-render. The client store updates
  optimistically, then reconciles with the revalidated server data.

## Testing

Every file ships with tests. Unit tests mock `ApiClient`/Server Actions (no network). Integration
tests run against MSW or a live backend, are named `*.integration.test.ts`, and are skipped unless
`TEST_API_BASE` is set.
