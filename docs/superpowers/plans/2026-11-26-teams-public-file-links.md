# Teams public file links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A download link's creator can make it public — downloadable by anyone with the URL, no account — while links stay members-only by default.

**Architecture:** A `public` flag on `team_file_link`, fixed at creation. A new anonymous Go route `GET /api/v1/file-links/:token` (own group, rate-limited, `ActiveGate`) serves only public links through the same checks as the members route minus the tenant comparison. The Share dialog gets a members/anyone radio.

**Tech Stack:** Go (Echo v5, pgx), Next.js + MUI, vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-teams-file-download-links-design.md` § Addendum: public links

## Global Constraints

- Default `public = false`; never changed after creation (no update route).
- Public route answers only `public = true` links; every failure is the same 404 `NOT_FOUND` "No such file.".
- Same expiry rule (`now < expires_at ≤ now + 90 days`), same managers, same response headers (`attachment`, `ETag`, `Cache-Control: private, no-store`, `nosniff`), same download count.
- Public URL `/api/v1/file-links/<token>`; members URL stays `/app/teams/links/<token>`.
- Token never logged: Go `LogRedact` + nginx `$eerp_loggable` both cover `/api/v1/file-links/`.
- `file-links` must not become an MCP root.

## Review Focus

- A members-only link used on the public route must 404 — test in Task 1.
- A public link whose creator lost access (removed from team) must 404 anonymously — test in Task 1.
- The public route needs no identity at all (no `auth.Identity` in context) and must not panic — test in Task 1.
- A public link still downloads through the members route — test in Task 1.
- `public` omitted from the POST body stays false — test in Task 1.

---

### Task 1: Backend — `public` flag and anonymous route

**Files:**
- Modify: `core/internal/teams/models.go` (`Link.Public bool \`db:"public"\``)
- Modify: `core/modules/teams/module.go` (`Migrate`: `ALTER TABLE team_file_link ADD COLUMN IF NOT EXISTS public boolean` + `notNullFalse("team_file_link", "public")`)
- Modify: `core/internal/teams/links_repository.go` (`linkColumns`, `scanLink` include `public`)
- Modify: `core/internal/teams/links_handler.go`
- Modify: `core/internal/app/app.go` (mount, `LogRedact`)
- Modify: `infra/nginx/nginx.conf` (`$eerp_loggable` regex adds `api/v1/file-links`)
- Test: `core/internal/teams/links_test.go`, `core/internal/app/mcp_test.go`

**Interfaces:**
- Produces:
  - `linkJSON.Public bool \`json:"public"\``; `CreateLink` body `{expires_at, public?}`; create `url` = `/api/v1/file-links/<token>` when public.
  - `func (h *Handler) PublicDownload(c *echo.Context) error` for `GET /:token` (no identity).
  - `func MountPublicLinks(g *echo.Group, h *Handler)` — no-op without S3; `g.GET("/:token", h.PublicDownload)`.
  - In `app.go`: `teams.MountPublicLinks(srv.Echo().Group("/api/v1/file-links", ormserver.AuthRateLimiter(publicRateLimit(configContent)), teams.ActiveGate(moduleRuntime.IsActive)), teamsHandler)`; `LogRedact` += `"/api/v1/file-links/"`.
  - Shared helper `func (h *Handler) serveLink(c *echo.Context, l Link) error` = the file/creator checks + count + headers + stream, used by both `DownloadLink` (after its tenant check) and `PublicDownload` (after its `l.Public` check).

- [ ] **Step 1: Failing tests** (`links_test.go`; `servePublic` = `serveReq` without `auth.SetIdentity`, a plain `echo.New().NewContext`):
  - `TestPublicLink_AnyoneDownloads`: POST `{expires_at, "public": true}` → 201, `url == "/api/v1/file-links/"+token`; `PublicDownload` with no identity → 200, body = content, `Cache-Control: private, no-store`; count = 1; the members route (`DownloadLink` as `f.staff`) → 200 too.
  - `TestPublicLink_404s` (table): members-only link (body without `public`) → 404 and its list row has `"public": false`; revoked; expired; creator removed from team; unknown token.
  - In `mcp_test.go`'s `TestApp_TeamsDownloadLinkRoutes`: anonymous `GET /api/v1/file-links/unknown` → 404 "No such file."; MCP `eerp_list_operations` search `file-links` returns no `/api/v1/file-links` operation.
- [ ] **Step 2:** `CONFIG=$PWD/../eerp-config.json go test ./internal/teams -run 'TestPublicLink' -timeout 400s` → FAIL (undefined).
- [ ] **Step 3:** Implement as the Interfaces block says; refactor `DownloadLink` onto `serveLink`.
- [ ] **Step 4:** `go vet ./internal/teams ./internal/app && CONFIG=… go test ./internal/teams ./orm/server -timeout 500s && CONFIG=… go test ./internal/app -run 'TestApp_TeamsDownloadLinkRoutes|TestApp_MCP'` → PASS.
- [ ] **Step 5:** Commit `feat(teams): public download links`.

### Task 2: Share dialog — who can use the link

**Files:**
- Modify: `core-front/apps/shell/src/teams/client.ts` (`FileLink.public: boolean`; `createLink(file, expiresAt, isPublic = false)` sends `{expires_at, public}`)
- Modify: `core-front/apps/shell/src/teams/ShareDialog.tsx`
- Modify: `core/modules/teams/i18n/teams.pot`, `fr.po` (`Workspace members only`, `Anyone with the link`, `Anyone who gets this link can download the file without signing in.`, `Public`)
- Test: `ShareDialog.test.tsx`, `client.test.ts`

**Interfaces:**
- Consumes: Task 1's create body and `public` list field.

- [ ] **Step 1: Failing tests:**
  - radio defaults to *Workspace members only*; Create link → `createLink('f1', <expiry>, false)`;
  - picking *Anyone with the link* shows the warning text; Create link → `createLink('f1', <expiry>, true)`; a created public link copies `origin + "/api/v1/file-links/tok"`;
  - a listed link with `public: true` shows a *Public* chip; `client.test.ts`: `createLink('f1', x, true)` body is `{"expires_at":x,"public":true}`.
- [ ] **Step 2:** `npx vitest run src/teams/ShareDialog.test.tsx src/teams/client.test.ts` (from `apps/shell`) → FAIL.
- [ ] **Step 3:** Implement: MUI `RadioGroup` (row) above the date field; `Alert severity="warning"` under it when public; `Chip size="small" label={t('Public')}` in public rows.
- [ ] **Step 4:** tests PASS; `npx tsc --noEmit`, `npx eslint` on changed files clean.
- [ ] **Step 5:** Commit `feat(teams): choose who can use a download link`.

### Task 3: Docs and full check

- Modify: `docs/adr/ADR-037-teams.md` § Download links (public option, why per-link and fixed, the anonymous route, pitfall: a public link is a bearer secret — anyone it's forwarded to downloads), `CLAUDE.md` Teams routes, `core-front/CLAUDE.md` Teams row, `docs/mcp.md` (public link route excluded).
- [ ] `make test` green with coverage gates; `graphify update .`; commit `docs(teams): public download links`; push to `feat/teams-file-links` (PR #77).
