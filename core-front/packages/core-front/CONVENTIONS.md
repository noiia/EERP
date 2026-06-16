# Conventions (contracts — source of truth)

These are the stable contracts every part of the EERP frontend (engine, host shell, and
business modules) must honor. This file is the single source of truth; point Claude Code at it
when implementing any task.

| Concern                | Contract                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base URL               | `{API_BASE}/api/v{API_VERSION}` — from env (`VITE_API_BASE`, `VITE_API_VERSION`, default `1`)                                                                                                                                                                                                    |
| Module routes          | `/{module}/` (list, create) + `/{module}/{id}` (get, update, delete). CRM contacts → `/crm/` + `/crm/{id}`                                                                                                                                                                                       |
| Core routes            | `GET /health`, `GET /ready`, `GET /modules`                                                                                                                                                                                                                                                      |
| Auth                   | `POST /auth/login {email, password}`; `POST /auth/refresh`                                                                                                                                                                                                                                       |
| Session transport      | **HttpOnly cookies primary** (`fetch` `credentials:'include'`); **token-in-body fallback**. Support both.                                                                                                                                                                                        |
| Token TTLs             | access **1h**, refresh **7d**, refresh **single-use** (rotation). Reusing a spent refresh = theft → server kills session → frontend hard-logout.                                                                                                                                                 |
| Error envelope         | `{ "error": { "code": "UPPER_SNAKE", "message": "...", "request_id": "01J..." } }`                                                                                                                                                                                                               |
| Status map             | 400 validation · 401 unauthenticated · 403 forbidden · 404 not found · 409 conflict · 500 `INTERNAL_ERROR`                                                                                                                                                                                       |
| Permissions            | DSL `module:resource:action` (`crm:contacts:` then `read` / `write` / `delete`). Wildcards `*:*:read`, `crm:*:read`. UI gates on the identity's effective set w/ wildcard matching.                                                                                                              |
| Delete                 | Soft-delete by default (ADR-003). `remove` archives; add `restore` when backend exposes it.                                                                                                                                                                                                      |
| View types (v1)        | `form`, `tree`, `dashboard`. New entity = a descriptor; new view type = one controller subclass + one renderer.                                                                                                                                                                                  |
| **Module FE contract** | `module.json.static_files.views` lists `.ts` files under the module's `views/`. Each file default-exports a **`FrontModule`** ( `{ name; routes:[{path; viewFactory:(api)=>BaseViewController; permission?}] }` ) registered with the engine. Modules import the engine from `@eerp/core-front`. |

## Module discovery

The host reads the **monorepo-root `eerp-config.json`** (the same file the backend reads), field
`module_root` — an array of paths that may point anywhere on disk. For each root it walks for
`module.json` files and resolves each `static_files.views` entry to `<module_dir>/views/<file>`.
A module is declared **once** and consumed by both backend (Go service / WASM) and frontend (views).

## Testing

Every file ships with tests. Unit tests mock `ApiClient` (no network). Integration tests run
against MSW or a live backend, are named `*.integration.test.ts`, and are skipped unless
`TEST_API_BASE` is set.
