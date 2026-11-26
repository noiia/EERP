# Teams file download links — design

## Intent

A team member wants to hand one file to a staff colleague — possibly someone
outside the team — by sending a link, without adding them to the team or
picking them in the share list. The link must always serve the file's latest
version and must stop working at an expiry date.

## Goals

- A per-file download link usable by any signed-in **staff** user of the
  tenant who holds it.
- Every link has an expiry date: 7 days by default, 90 days at most, chosen
  by the user in the file's Share dialog.
- The link grants exactly one thing: downloading that file's current content.
  No listing, no browsing, no other route answers because of it.
- A Share icon button in the file view (the office viewer) opening the same
  dialog.

## Non-goals

- Anonymous / external (no account) access, website visitors.
- Passwords, download-count limits.
- Direct-from-S3 presigned downloads (possible later improvement, needs Garage
  reachable through the gateway).

## Anti-goals

- A copy ("replica") of the file that could drift from the original.
- A link that keeps working after its expiry, revocation, the file's deletion,
  or its creator losing access to the file.

## Approaches

- **A. Link to the file itself (picked).** A token row points at the file id;
  edits keep the id (`ReplaceFileContent`), so the link always serves the
  latest content with nothing to sync. Access is a capability on one file, not
  folder rights.
- **B. Replica in a restricted folder (rejected).** Every write path would have
  to re-copy; a missed or failed copy serves a stale file; storage doubles; a
  new folder permission model to get wrong.
- **C. A + presigned S3 redirect (deferred).** Offloads bytes from Go for large
  files, but Garage isn't exposed through the gateway today.

## Design

### Data — `team_file_link` (`orm.WithExcluded()`, in `core/modules/teams`)

`tenant_id`, `team_id`, `file_id`, `token_hash` (sha256 hex of the raw token,
unique index), `expires_at` (TIMESTAMPTZ, NOT NULL), `created_by`,
`download_count` (int, default 0), `last_download_at` (nullable), BaseModel
timestamps (revoke = soft delete via `deleted_at`). The raw token (32 random bytes, base64url) is
returned once at creation and never stored — same pattern as `event_feed`.

### Routes (`internal/teams`, under `/api/v1/teams`, `jwtMw` + `ActiveGate`)

| Route | Who | Behavior |
|---|---|---|
| `GET /files/:file/links` | whoever may share the file today (editor of it, or team owner) | live links: id, expires_at, created_by name, created_at |
| `POST /files/:file/links {expires_at}` | same | 422 unless `now < expires_at <= now + 90 days`; returns `{id, token, url, expires_at}` once |
| `DELETE /files/links/:link` | same, on the link's file | sets `revoked_at` |
| `GET /links/:token/download` | any staff user of the link's tenant | streams the file |

Download checks, all failing as **404** (never revealing which): token hash
unknown, other tenant, revoked, expired, file deleted, or the creator can no
longer read the file (team membership / private-folder visibility re-checked
with the creator's identity). Website-audience tokens are already refused by
`authenticate`. Response: `Content-Disposition: attachment`, `ETag`
(`fileVersion`), `Cache-Control: private, no-store`, `X-Content-Type-Options:
nosniff`; streamed like `DownloadFile` (no Range in v1: `ObjectStore.Get`
returns a non-seekable stream). Rate-limited like the public group. Each
successful download bumps the link's `download_count` / `last_download_at`,
shown in the Share dialog (Teams files have no activity feed, so a chatter
entry would be invisible).

Deleting the file (or its folder/team) deletes its links in the same
transaction, next to the existing `team_file_share` cleanup.

### Frontend (`core-front/apps/shell/src/teams`)

- `ShareDialog`: a **Download links** section — date field (default today + 7
  days, max today + 90), **Create link** (copies the URL to the clipboard and
  shows it once), list of live links with expiry and **Revoke**.
- Office viewer: a Share icon button opening `ShareDialog`, shown only when
  the viewer may share the file.
- Page `/app/teams/links/[token]`: inside the signed-in app layout; triggers
  the download through the existing BFF catch-all
  (`/api/teams/links/<token>/download`), so the browser never calls Go
  directly.
- `client.ts`: `getLinks`, `createLink`, `revokeLink`.

### MCP, docs

- `teams` is already an admitted MCP root, so the new routes are discovered
  automatically; add a test that they appear in the catalog.
- Update ADR-037, the Teams paragraph of `CLAUDE.md`, `docs/mcp.md`.
- Teams tables must be dropped/kept consistently by `dbmanage` (no object key
  on the link row, so `manifestSources` is unchanged).

## Left to the builder

Exact handler/repository split, test layout (DB tests on isolated tenants),
i18n msgids, the clipboard fallback when the Clipboard API is unavailable.

## Calls made by Claude (not explicitly decided)

- "File view" = the office viewer; the files list already has a Share button.
- Link managers = the users allowed to share the file today.
- Creator losing access kills the link.
- Downloads counted on the link row (not chatter); `no-store` caching; no Range in v1.
- Revoke is a soft delete of the link row.
