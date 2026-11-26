# Teams file download links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Teams file can get expiring secret links that let any signed-in staff user of the workspace download that one file's current content, managed from the file's Share dialog, with a Share button in the office viewer.

**Architecture:** A `team_file_link` row (sha256 of the token, mandatory expiry) points at the file id; since edits keep the id, the link always serves the latest object. Three management routes and one download route live in `internal/teams` behind the existing `/api/v1/teams` group (`jwtMw` + `ActiveGate`); the download route adds a rate limiter and re-checks the link creator's access. The frontend extends `ShareDialog`, adds an optional header slot to `OfficeDialog`, and a landing page that triggers the download through the existing `/api/teams/[[...path]]` BFF.

**Tech Stack:** Go (Echo v5, core ORM, pgx), Next.js App Router + MUI, vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-teams-file-download-links-design.md`

## Global Constraints

- Expiry: default today + 7 days in the UI; server accepts only `now < expires_at <= now + 90 days` (422 otherwise).
- Token: 32 random bytes (`crypto/rand`), base64url without padding; only `hex(sha256(token))` is stored; the raw token is returned once, by the POST.
- Every failure on the download route is **404 `NOT_FOUND`** (unknown/other tenant/revoked/expired/file deleted/creator lost access) — never 403, never distinguishing causes.
- Download response headers: `Content-Disposition: attachment` (same `mime.FormatMediaType` as `DownloadFile`), `ETag: fileVersion(objectKey)`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`.
- Link managers = callers passing the same rule as `PutShares`: `fileRole(c, false)` then `CanEditItem(role, f.UploadedBy, caller)`; else 403 (non-member 404 via `fileRole`).
- Table is `orm.WithExcluded()`; no generic CRUD.
- Search with `rg`, prefix commands with `rtk`. No commit is pushed; commit only if the user asked for commits at execution time.

## Review Focus

- A link whose creator was removed from the team (or the file moved into a private folder they can't see) must stop working — test in Task 3.
- A link from tenant A used by a staff user of tenant B must 404 — test in Task 3.
- `expires_at` exactly in the past, equal to now, and 90 days + 1 minute must be 422 — test in Task 2.
- After the file content is replaced (`ReplaceFileContent`), the link serves the new bytes — test in Task 3.
- Deleting the file, its folder tree, or the team removes its links (no dangling live links) — test in Task 1.

---

### Task 1: `team_file_link` model, migration, repository

**Files:**
- Modify: `core/internal/teams/models.go` (add `Link`)
- Modify: `core/modules/teams/module.go` (register + unique index)
- Modify: `core/modules/teams/module_test.go:16` (add `"team_file_link"` to the table list)
- Create: `core/internal/teams/links_repository.go`
- Modify: `core/internal/teams/repository.go` (`DeleteTeam` ~L215, `DeleteFile` ~L1021, `DeleteFolderTree` ~L1066: delete `team_file_link` rows next to each `team_file_share` delete)
- Test: `core/internal/teams/links_test.go`

**Interfaces:**
- Produces:
  - `type Link struct { model.BaseModel; TenantID, TeamID, FileID, CreatedBy uuid.UUID; TokenHash string; ExpiresAt time.Time; DownloadCount int; LastDownloadAt *time.Time }` with db columns `tenant_id, team_id, file_id, created_by, token_hash, expires_at, download_count, last_download_at`, `TableName() = "team_file_link"`, soft-delete via BaseModel `deleted_at`.
  - `func HashToken(raw string) string` (hex sha256)
  - `func (r *Repository) CreateLink(ctx, l Link) (Link, error)`
  - `func (r *Repository) ListLinks(ctx, tenant, file uuid.UUID) ([]Link, error)` — live (not deleted, `expires_at > now()`), newest first
  - `func (r *Repository) FindLink(ctx, tenant, id uuid.UUID) (Link, error)` — live only, `orm.ErrNotFound` otherwise
  - `func (r *Repository) RevokeLink(ctx, tenant, id uuid.UUID) error` — sets `deleted_at = now()`
  - `func (r *Repository) ResolveLink(ctx, tokenHash string) (Link, error)` — any tenant, live and unexpired only, `orm.ErrNotFound` otherwise
  - `func (r *Repository) CountDownload(ctx, tenant, id uuid.UUID) error` — `download_count = download_count + 1, last_download_at = now()`

- [ ] **Step 1: Write failing tests** in `links_test.go` using `newChatFixture(t, true)` and `f.upload`:
  - `TestLinks_CreateResolveRevoke`: create link (hash `HashToken("tok")`, expires +1h) → `ResolveLink(HashToken("tok"))` returns it; `RevokeLink` → `ResolveLink` is `orm.ErrNotFound`.
  - `TestLinks_ExpiredNotResolved`: insert with `ExpiresAt` = now − 1 min → `ResolveLink` `ErrNotFound`, `ListLinks` empty.
  - `TestLinks_DeletedWithFileFolderTeam`: three links (file at root, file in a folder, file in a second team); `DeleteFile`, `DeleteFolderTree`, `DeleteTeam` → each `ResolveLink` `ErrNotFound`.
  - `TestLinks_CountDownload`: `CountDownload` twice → `FindLink(...).DownloadCount == 2`, `LastDownloadAt != nil`.
- [ ] **Step 2:** `cd core && rtk go test ./internal/teams -run TestLinks` → FAIL (undefined).
- [ ] **Step 3:** Register in `module.go`: `orm.Register[teams.Link](orm.WithTableName("team_file_link"), orm.WithExcluded())`; add to the `Migrate` SQL list: `CREATE UNIQUE INDEX IF NOT EXISTS uq_team_file_link_token ON team_file_link (token_hash)` and `CREATE INDEX IF NOT EXISTS idx_team_file_link_file ON team_file_link (file_id) WHERE deleted_at IS NULL`. Implement the repository functions; in the three delete paths add `DELETE FROM team_file_link WHERE tenant_id=$1 AND file_id …` with the same file selection as the adjacent `team_file_share` delete.
- [ ] **Step 4:** `rtk go test ./internal/teams ./modules/teams` → PASS.
- [ ] **Step 5:** Commit `feat(teams): team_file_link table and repository`.

### Task 2: Link management routes

**Files:**
- Create: `core/internal/teams/links_handler.go`
- Modify: `core/internal/teams/handler.go` (`Mount`, inside the `h.objects != nil` block)
- Test: `core/internal/teams/links_test.go`

**Interfaces:**
- Consumes: Task 1 repository functions, `fileRole`, `CanEditItem`, `forbidden`, `invalid`, `notFound`, `h.userMap`.
- Produces (routes, JSON):
  - `GET /files/:file/links` → `200 [{id, expires_at, created_by_name, created_at, download_count, last_download_at}]`
  - `POST /files/:file/links {expires_at: RFC3339}` → `201 {id, token, url: "/app/teams/links/<token>", expires_at, created_by_name, created_at, download_count: 0, last_download_at: null}`
  - `DELETE /files/links/:link` → `204` (link's file resolved with `fileRoleByID`, same manager rule)
  - Handlers `ListLinks`, `CreateLink`, `RevokeLink` on `*Handler`.

- [ ] **Step 1: Write failing tests:**
  - `TestLinkRoutes_ManagerRule`: uploader member → POST 201; other member 403; guest 403; owner 201; non-member 404 (use `f.guest2` for "other member" as `TestFiles_RoleMatrix` does).
  - `TestLinkRoutes_ExpiryBounds` (table-driven): `expires_at` now−1m → 422, now → 422, now+90d+1m → 422, malformed → 400, now+7d → 201, now+90d−1m → 201.
  - `TestLinkRoutes_ListAndRevoke`: POST twice, GET lists 2 with no `token` key in the JSON; DELETE one → 204; GET lists 1; DELETE by a non-manager → 403.
- [ ] **Step 2:** `rtk go test ./internal/teams -run TestLinkRoutes` → FAIL.
- [ ] **Step 3:** Implement the three handlers; mount `g.GET("/files/:file/links", h.ListLinks)`, `g.POST("/files/:file/links", h.CreateLink)`, `g.DELETE("/files/links/:link", h.RevokeLink)` next to the shares routes.
- [ ] **Step 4:** `rtk go test ./internal/teams` → PASS.
- [ ] **Step 5:** Commit `feat(teams): manage file download links`.

### Task 3: Download route, rate limit, MCP check

**Files:**
- Modify: `core/internal/teams/links_handler.go` (`DownloadLink`)
- Modify: `core/internal/teams/handler.go` (`MountLinks`)
- Modify: `core/internal/app/app.go:731` (call `MountLinks` on the same group with the public rate limiter)
- Modify: `core/internal/app/mcp_test.go` (or `app_test.go`'s route table)
- Test: `core/internal/teams/links_test.go`

**Interfaces:**
- Consumes: `ResolveLink`, `CountDownload`, `FindFile`, `RoleOf`, `folderVisible`, `fileVersion`, `h.objects`.
- Produces:
  - `func (h *Handler) DownloadLink(c *echo.Context) error` for `GET /links/:token/download`
  - `func MountLinks(g *echo.Group, h *Handler, limit echo.MiddlewareFunc)` — no-op when `h.objects == nil`; registers `g.GET("/links/:token/download", h.DownloadLink, limit)`.
  - In `app.go`: `teamsGroup := srv.Echo().Group(...)` reused for `teams.Mount` and `teams.MountLinks(teamsGroup, teamsHandler, ormserver.AuthRateLimiter(publicRateLimit(configContent)))`.

Order of checks in `DownloadLink`: resolve hash → link.TenantID must equal caller's tenant → `FindFile(tenant, link.FileID)` → `RoleOf(tenant, file.TeamID, link.CreatedBy)` must succeed and `folderVisible(..., link.CreatedBy, role, file.FolderID)` be true → stream like `DownloadFile` with the constraint headers → `CountDownload` after headers are written (log, don't fail, on error). Any failing check → `notFound(c, "file")`.

- [ ] **Step 1: Write failing tests:**
  - `TestDownloadLink_AnyStaffOfTenant`: link created by uploader; a staff user of the same tenant **not in the team** downloads → 200, body = content, headers `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Disposition` contains the filename; `DownloadCount == 1`.
  - `TestDownloadLink_404s` (table-driven): unknown token, revoked, expired (update `expires_at` by SQL), file deleted, caller of another tenant, creator removed from the team (`RemoveMember`), file's folder linked to a private channel the creator can't see → each 404 with code `NOT_FOUND`.
  - `TestDownloadLink_ServesLatestContent`: link, then `repo.ReplaceFileContent` with a new object key/bytes in `memStore` → download returns the new bytes and the new `ETag`.
  - In the app route test: `GET /api/v1/teams/links/:token/download` is registered when S3 is configured, and the MCP operation catalog lists `/api/v1/teams/files/{file}/links`.
- [ ] **Step 2:** `rtk go test ./internal/teams -run TestDownloadLink` → FAIL.
- [ ] **Step 3:** Implement `DownloadLink`, `MountLinks`, wire in `app.go`.
- [ ] **Step 4:** `cd core && rtk go test -race ./internal/teams ./internal/mcpbridge ./orm/server && rtk go test ./internal/app` → PASS; `make run-deadcode` passes.
- [ ] **Step 5:** Commit `feat(teams): download a file through its secret link`.

### Task 4: Share dialog — Download links section

**Files:**
- Modify: `core-front/apps/shell/src/teams/client.ts`
- Modify: `core-front/apps/shell/src/teams/ShareDialog.tsx`
- Test: `core-front/apps/shell/src/teams/ShareDialog.test.tsx`, `client.test.ts`
- Modify: shell `.po` files for new msgids (`Download links`, `Expires on`, `Create link`, `Link copied`, `Revoke`, `Downloads`, `Anyone signed in to this workspace with the link can download this file until it expires.`)

**Interfaces:**
- Produces in `client.ts`:
  - `type FileLink = { id: string; expires_at: string; created_by_name: string; created_at: string; download_count: number; last_download_at: string | null; url?: string; token?: string }`
  - `getLinks(fileId: string): Promise<FileLink[]>` → `GET /files/${fileId}/links`
  - `createLink(fileId: string, expiresAt: string): Promise<FileLink>` → `POST`
  - `revokeLink(linkId: string): Promise<void>` → `DELETE /files/links/${linkId}`
- `ShareDialog` props unchanged.

- [ ] **Step 1: Write failing tests** (mock client like the existing `ShareDialog.test.tsx`):
  - shows the date field defaulting to today + 7 days, with `max` = today + 90 days;
  - **Create link** calls `createLink(fileId, <end of the chosen day, ISO>)`, writes `window.location.origin + url` to `navigator.clipboard.writeText` (when present), and shows the URL in a read-only field;
  - lists existing links with expiry and download count; **Revoke** calls `revokeLink(id)` and removes the row;
  - a 422 from `createLink` shows its message.
- [ ] **Step 2:** `cd core-front && rtk vitest run apps/shell/src/teams/ShareDialog.test.tsx` → FAIL.
- [ ] **Step 3:** Implement: a section below the user picker, independent from the dialog's Save (links are created/revoked immediately). Date input `type="date"`; convert the picked day to its local 23:59 as ISO before sending.
- [ ] **Step 4:** Tests PASS; `rtk pnpm --filter shell typecheck` (or the repo's equivalent `make test-front` subset) clean.
- [ ] **Step 5:** Commit `feat(teams): create and revoke download links from the Share dialog`.

### Task 5: Share button in the office viewer + link landing page

**Files:**
- Modify: `core-front/packages/core-front/src/views/office-file.tsx` (`OfficeDialog` and `OfficeFileLink` get `headerActions?: ReactNode`, rendered just before the Download button)
- Modify: `core-front/apps/shell/src/teams/FilesPane.tsx` (~L619 `OfficeFileLink` and ~L645 `OfficeDialog`: pass a Share `IconButton` (`faShareNodes`, `aria-label={t('Share')}`) opening `ShareDialog` when `canEdit(f.uploaded_by)`)
- Modify: `core-front/apps/shell/src/teams/TeamsShell.tsx` (`routeOf`: `a === 'links'` → `null`)
- Create: `core-front/apps/shell/app/app/teams/links/[token]/page.tsx` + `LinkDownload.tsx` (client)
- Test: `office-file` test, `FilesPane.test.tsx`, `TeamsShell.test.tsx`, `pages.test.tsx`

**Interfaces:**
- Consumes: `ShareDialog` (Task 4), download route (Task 3) via `/api/teams/links/<token>/download`.
- Page: `await requireAuth('/teams/links/<token>')`, `notFound()` when `teams` inactive (same as `shared/page.tsx`), renders `<LinkDownload token={token} />`: a centered card with a **Download** button (`href` = BFF URL, `download`) that is also auto-clicked once on mount, and a note that an expired or revoked link gives "File not found".

- [ ] **Step 1: Write failing tests:**
  - `OfficeDialog` renders `headerActions` in its header;
  - `FilesPane`: opening an office file as its uploader shows a **Share** button in the viewer that opens the Share dialog; as another member it is absent;
  - `routeOf(['links', 'abc'])` returns `null`;
  - the page redirects anonymous users (mocked `requireAuth`) and renders a Download link to `/api/teams/links/abc/download`.
- [ ] **Step 2:** `rtk vitest run` on those files → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(teams): share button in the office viewer and download-link page`.

### Task 6: Docs and full check

**Files:**
- Modify: `docs/adr/ADR-037-teams.md` (new "Download links" section: why a link to the file not a replica, token hashing, 404 rule, creator re-check, 90-day cap)
- Modify: `CLAUDE.md` Teams paragraph (routes + pitfall: the link dies with its creator's access)
- Modify: `docs/mcp.md` (~L221: mention file download links in the teams routes)

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `make test` → all three chains green, coverage floors met.
- [ ] **Step 3:** `graphify update .`
- [ ] **Step 4:** Commit `docs(teams): file download links`.
