# Teams v2 + LDAP photos — design

Status: approved to build (2026-11-09). The parts the user chose are marked **(user)**. Everything else was my call, marked *(call)*. This builds on [the Teams v1 design](2026-11-09-teams-design.md) and [ADR-037](../../adr/ADR-037-teams.md).

## Intent

Teams v1 works, but people want to:
- shape their own sidebar;
- keep a conversation's files together with the conversation;
- hold conversations with only part of a team.

Separately, people signing in through LDAP should carry their directory photo into the ERP.

## Goals

1. **LDAP photo.** When someone signs in with LDAP, the photo stored in the directory becomes their ERP avatar. The avatar shows next to them in Teams (members list, messages, direct messages) and in the top-bar account menu **(user)** (*call: these surfaces*).
2. **Breadcrumb.**
   - *Already done:* the Teams breadcrumb shows team, channel and person names instead of UUIDs. That fix (`efb29a3`) only needs a frontend rebuild. The user saw UUIDs because the running container predates it.
   - *New:* every click in the Teams left panel starts a fresh trail, `Teams › <current page>`, instead of adding a crumb **(user)**. This covers channels, direct messages, folders and Shares.
   - *New:* a folder page's crumb names the folder: `Sales / Files / Contracts` *(call)*.
3. **Reorder conversations.** Press and drag a channel or direct conversation to reorder it. Every user may do it, and the order is saved **per user** **(user)**.
4. **Folder panel.** A team conversation can be linked to a folder. That folder opens in a new **right panel** beside the chat **(user)**.
5. **Linking and auto-created folders.**
   - A team owner links an existing folder to a conversation **(user)**. A folder can be linked to at most one conversation *(call)*.
   - Every file sent in a team conversation, whether dropped or picked with the paperclip, is stored in the linked folder, and the message links to those files **(user)**.
   - If no folder is linked, the first file sent creates a folder at the team root, named after the conversation. That folder is linked automatically, and the files go into it **(user)**.
   - Direct messages keep plain attachments, since there is no team to hold a folder *(call)*.
6. **Private conversations.** Each team conversation gets a member list holding users and **user groups**.
   - An empty list means the conversation is open to the whole team, as today.
   - A non-empty list makes the conversation **private**: only listed users, directly or through a group, see and read it **(user)**. Team owners always see and manage every conversation **(user)**.
7. **Team groups.** Groups are created **per team** by team owners, from that team's members **(user)**.
8. **Folder privacy.** A folder linked to a private conversation, together with everything below it, is visible in Files only to that conversation's members and the team owners **(user)**.

## Non-goals

- Uploading an avatar by hand, or avatars from OIDC. Only LDAP photos for now.
- Avatars outside Teams and the account menu, such as the chatter and Settings → Users. They can come later through the same component.
- Group membership synced from LDAP. Team groups are managed by hand.
- A team-wide default order for the sidebar. Order is per user only.

## Anti-goals

- **Private conversations must not leak.** A conversation's existence, messages, unread counts, mentions, live frames and linked folder must never reach a team member who isn't allowed to see it. Wherever a v1 check said "team member", it must now say "can see this conversation".
- **Private folders must not leak.** A private folder's files must not appear to such a member through any route: listing, download, breadcrumbs, a move target, the Shares view, or a folder picker. One exception stays: a file shared explicitly with a person remains downloadable by that person, because shares are per person.
- **No silent data loss.** A failed LDAP photo sync must never block a sign-in.

## Design

### LDAP photo

- The LDAP config gains `photo_attr` (empty = no sync). The *LLDAP defaults* preset fills it with `jpegPhoto` *(call)*. The connector requests that attribute along with the others at sign-in.
- **Storing the photo.** After a successful LDAP sign-in, the photo's bytes (JPEG or PNG, at most 2 MB, otherwise ignored and logged) are stored through the picture service on the anchor `(users, <user id>, avatar)`. A new `users.avatar` boolean flag column is set, following the existing picture flag-column convention. The photo is replaced only when its bytes changed (compared by hash). A directory entry without a photo clears the avatar.
- **Failures.** Sync errors are logged as warnings. The sign-in still succeeds.
- **Serving it.** A new route `GET /api/v1/avatars/:user` (JWT only, same tenant, staff users) streams the avatar, with `Cache-Control: private, max-age=300`. It returns 404 when there is none. The browser reaches it through the BFF `GET /api/avatars/[user]`.
- **Showing it.** `AvatarWithPresence` gains an optional `src`. Payloads that list users (Teams members, directory, direct messages, message authors, `/me/preferences` for the account menu) gain `has_avatar`, so the frontend only asks for an image that exists. The initial letter remains the fallback.
- **Without storage.** With no S3 configured, nothing syncs and nothing changes.

### Breadcrumb

- `useBreadcrumbStore` gains `reset()`, which empties the trail. Every Teams sidebar link calls it on click, before navigating, so the next visit records `Teams` (when the trail was empty, the dashboard crumb is synthesized) and then the current page *(call: show `Teams` first so the trail always has a way back)*.
- The files page reports `Sales / Files / <folder name>` while a folder is open.

### Per-user order

- `chat_channel_member` (the per-user row that already holds the read cursor) gains `position int NULL`.
- `PUT /api/v1/teams/:id/channels/order {ids}` and `PUT /api/v1/teams/direct/order {ids}` upsert the caller's positions. Ids must be channels the caller can see; others get 422.
- Lists sort by position (nulls last), then name, or last message time for direct conversations.
- UI: HTML5 drag-and-drop on the sidebar items, the same mechanism as Kanban, with an optimistic reorder that reverts on failure. *(call)* Alt+↑/↓ on a focused item moves it, so keyboard users can reorder too.

### Linked folder

- `chat_channel.folder_id uuid NULL`, with a unique live index (one conversation per folder). Only team channels can have one.
- `PUT /teams/:id/channels/:channel {folder_id}` sets it, owners only. It returns 422 if the folder is in another team or already linked elsewhere, and `""` unlinks.
- Deleting a folder unlinks it. Deleting a channel leaves its folder in place *(call: files outlive the chat)*.
- **Right panel.** A *Folder* toggle in the chat header opens a right panel showing the linked folder. It is the files pane with that folder as root: browse, download and upload within role, no breadcrumb above the folder. Owners without a linked folder get a *Link a folder* picker. Members see "No folder yet. Files sent here will create one". On phone the panel becomes a drawer.

### Files sent in a team conversation

- `POST /channels/:channel/messages` with files, in a team channel:
  1. Resolve the linked folder. If there is none, create `<conversation name>` at the team root, inside the same transaction, link it, and use it. `created_by` is the sender. A name collision gets a suffix: `general (2)`.
  2. Store each file as a `team_file` in that folder.
  3. Record the message with links to those files. A new `chat_message_file (message_id, file_id)` table holds them.
- The wire `attachments` entries for those files point at `/files/:file/download` (`kind: "file"`, beside the existing `kind: "attachment"`).
- Deleting a linked file later shows that message's entry as "File deleted".
- Direct messages keep plain attachments.
- **Images show as pictures, not files (user).**
  - Any image sent in a conversation shows inline in the message as a picture: a team file or a direct-message attachment, with MIME type `image/jpeg`, `image/png`, `image/gif` or `image/webp`.
  - The picture is a thumbnail capped at about 320×240 px that keeps its aspect ratio, lazy-loaded.
  - Clicking it opens the full-size image in a viewer, with a download button.
  - Several images in one message show as a small grid.
  - Any other file, SVG included *(call: SVG can carry scripts when opened directly)*, stays a file chip with its name and size.
  - The picture loads from the same authorized download route. An `<img>` renders regardless of `Content-Disposition`, so no new route is needed. The wire attachment entry already carries `mime`.

### Private conversations and groups

- **New tables:**
  - `team_group (team_id, name)`
  - `team_group_member (group_id, user_id)`
  - `chat_channel_access (channel_id, user_id NULL, group_id NULL)`, with exactly one of `user_id`/`group_id` set
  - unique live indexes on each
- **Routes, owners only:**
  - `GET|POST /teams/:id/groups`, `PUT|DELETE /teams/:id/groups/:group`, with members as `{name, user_ids}` (team members only, 422 otherwise)
  - `GET|PUT /teams/:id/channels/:channel/access {user_ids, group_ids}`, which replaces the whole list
- **Visibility rule (one function, used everywhere):** `canSeeChannel(role, user, channel)` = owner, OR the access list is empty, OR the user is listed directly or through a group.
  - Every v1 path that checked "team member" for a channel uses it instead: list channels, messages, read, reactions, attachments, mentions audience, live-frame audience, unread counts, `TeamSummary.unread`.
  - Unknown or invisible gives 404.
- **Folder visibility:** a folder is restricted when it, or any ancestor, is linked to a private channel. Restricted folders and their files are visible only to people who can see that channel.
  - This is enforced in: listing (root and inside), `GET /:id/files?folder=`, download (an explicit share still passes), move targets, path breadcrumbs, `DeleteFolderTree` callers, and the Shares view (explicit shares only).
  - Moving a folder or file into or out of a restricted subtree requires being able to see both sides.
- **Leaving the team:** removing a user from the team removes them from that team's groups and access lists.
- **UI:**
  - Owners get *Manage access* in each channel's menu: a dialog listing users and groups with add/remove, and "Open to the whole team" when the list is empty.
  - Owners get *Groups* in the team menu: create, rename and delete groups, and pick members.
  - Private channels show a lock icon in the sidebar.

## Testing

- **Go:** the visibility matrix (owner, listed user, user via a group, unlisted member, outsider) across every channel and folder route; auto-folder creation including the name collision; per-user order; LDAP photo sync (new, unchanged, removed, oversize) with a fake directory and object store; the avatar route's tenant isolation.
- **Frontend:** the drag-reorder store and its revert; breadcrumb reset; the right panel; the access and groups dialogs; `AvatarWithPresence` with `src`.
- **Coverage:** floors per CLAUDE.md. Go sits at 85.3%, so the new Go code ships with its tests.

## Docs

Update ADR-037 (private conversations, linked folders, files sent into folders), ADR-030 (photo attribute), the `CLAUDE.md` `internal/teams` and auth bullets, and the `core-front/CLAUDE.md` Teams and Presence rows.

## Left to the builder

The visual design of the right panel, the dialogs and the lock icon; drag affordance details; the exact upload size cap reused from `upload_body_limit`.
