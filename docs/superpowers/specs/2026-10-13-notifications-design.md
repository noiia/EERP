# Notifications & live activity — design

Date: 2026-10-13 · Status: approved design, pending implementation plan

## Goal

Give every ERP user a live view of what is happening that concerns them:

- **Global activities** running in the workspace — scheduled actions (crons), demo-data
  seeding, and any long job added later — with live progress while they run and a short
  history once they finish, visible according to the user's roles.
- **Personal notifications** addressed to one user (e.g. "your seed finished"), never
  visible to anyone else.

They appear under a bell in the top bar (left of the company logo). A breathing red dot
on the bell signals that something new arrived. Clicking a notification opens the page
it is about. The full demo-data seed, today a silent ~40 s request, shows a live progress
loader through the same mechanism.

Notifications are a **core** facility (`core/internal/notify`): core code and modules
raise them through one Go API; no module owns the subsystem.

### Decisions taken during design

| Question | Decision |
|---|---|
| Scope of a personal notification | Per **user** (every session/tab of that user), stored, read/unread state, kept 30 days. |
| What a role controls | A checklist of **global categories** (Scheduled actions, Demo data seeding, …). Personal notifications always reach their owner and are not configurable. |
| Global feed contents | **Running now** (live) + finished/failed activities kept 7 days, read/unread per user. |
| Live delivery | **Reuse the presence WebSocket** as one live channel, filtered per connection server-side. |

## Non-goals

- Email/push delivery of notifications (the mail outbox stays separate).
- Per-user muting of categories or of personal notifications.
- Multi-instance fan-out: like presence, the hub covers one `core-back` process
  (NATS fan-out is the documented upgrade path, ADR-019).
- Cancelling a running activity from the bell.

## 1. Backend core — `core/internal/notify`

### Data model

Off the generic CRUD surface (like `internal/chatter`), tenant-scoped.

`notification`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | BaseModel |
| `tenant_id` | uuid | |
| `user_id` | uuid NULL | set = personal (owner); NULL = global |
| `category` | text | registered category key, e.g. `cron`, `dev_seed` |
| `kind` | text | `message` (personal one-off) or `activity` (a job with a lifecycle) |
| `title` | text | ≤ 200 chars |
| `body` | text | optional detail (result summary, error message) |
| `link` | text | ERP-relative path, e.g. `/settings/developer`; validated: starts with exactly one `/`, no scheme |
| `status` | text NULL | activities only: `running`, `done`, `failed` |
| `progress` | int NULL | 0–100; NULL = indeterminate |
| `progress_label` | text NULL | e.g. "Seeding invoices (5/8)" |
| `actor_id` | uuid NULL | user who started the activity |
| `finished_at` | timestamptz NULL | |
| `created_at` / `updated_at` | | BaseModel |

Index: `(tenant_id, user_id, created_at DESC)` and `(tenant_id, category, created_at DESC) WHERE user_id IS NULL`.

`notification_read` — `(tenant_id, user_id, notification_id, read_at)`, unique
`(user_id, notification_id)`. Read state is per user, so one global row can be unread for
one user and read for another; personal rows use the same table for uniformity.

`role_notification_category` — `(tenant_id, role_id, category)`, unique `(role_id, category)`.

A user's **allowed categories** = the union over the closure of their roles (direct
`user_roles` plus every role they transitively belong to, the same recursive closure
`UserRepository.FindGroups` walks — a sibling query returning role ids).

**Retention** (daily sweep, hard delete with their `notification_read` rows): finished
global activities after 7 days, personal notifications after 30 days. A `running` row is
never swept.

### Categories

`notify.RegisterCategory(Category{Key, Label})` at `init()` (mirrors
`mail.RegisterTemplate`). `Label` is an English msgid translated by the frontend. First
two: `cron` → "Scheduled actions", `dev_seed` → "Demo data seeding". An unregistered
category is a programming error (`Start`/`Personal` return an error).

### Go API

```go
// One-off personal message.
notify.Personal(ctx, tenantID, userID, notify.Message{
    Category: "dev_seed", Title: "Demo data seeded in 38 s", Link: "/settings/developer",
})

// A global activity with a lifecycle.
run, err := notify.Start(ctx, tenantID, notify.Activity{
    Category: "dev_seed", Title: "Seeding demo data", Link: "/settings/developer", ActorID: userID,
})
run.Progress(62, "Seeding invoices (5/8)") // throttled, see §3
run.Finish(nil)                             // or run.Finish(err): status failed, body = err message
```

Every call writes the row, then publishes it on the live channel (§3). `Finish` always
publishes immediately (never throttled).

### HTTP

All behind the ERP JWT middleware; the caller (tenant + user) comes from the token only.

| Route | Purpose | Permission |
|---|---|---|
| `GET /api/v1/notifications` | caller's feed: running activities, then the rest newest first (personal + allowed globals, within retention), each with `read`; plus `unread` count | JWT only (it is the caller's own feed) |
| `POST /api/v1/notifications/read` | `{ids: [...]}` or `{all: true}` — marks the caller's rows read | JWT only |
| `GET /api/v1/notification_categories` | registered categories `{key, label}` | JWT only |
| `GET\|PUT /api/v1/roles/:id/notification_categories` | a role's ticked categories | `roles:roles:read` / `roles:roles:write` (the roles admin surface, route-derived) |

### Privacy invariant (the security boundary)

Every read and write path filters on

```
tenant_id = caller.tenant AND (user_id = caller.user OR (user_id IS NULL AND category = ANY(caller.categories)))
```

- No route accepts another user's id; the feed and mark-read act on the caller only.
- Marking read inserts `notification_read` rows only for ids that pass the filter above;
  others are silently ignored (no existence oracle).
- A personal notification's id is meaningless to anyone else: it never appears in their
  feed, cannot be marked read by them, and the live channel never sends it to them (§3).

## 2. Producers

### Full demo-data seed (`internal/devseed`)

- `POST /api/v1/dev_seed` keeps its synchronous validation (development only → 403;
  nothing left to seed → 409; unknown group → 400), then starts the seed in a background
  goroutine and answers **`202 {notification_id}`** at once.
- The seed itself is unchanged: one transaction, so a failure still rolls back everything.
- Progress is reported between steps: each selected group (and its prepare step), then the
  graph-views/calculated-fields pass, mapped to a percentage, with a label such as
  "Seeding invoices (5/8)".
- One seed per tenant at a time: a second `POST` while one is running → 409.
- On completion the activity becomes `done` (body: rows/seconds summary) or `failed`
  (body: the error); the initiator additionally gets a **personal** notification
  ("Demo data seeded in 38 s" / "Demo data seeding failed") linking to `/settings/developer`.
- Crash safety: at boot, any `running` activity is marked `failed` ("Interrupted by a
  restart") — the transaction it belonged to was rolled back by Postgres.
- `GET /api/v1/dev_seed` additionally returns the running seed's `notification_id`, if
  any, so the Developer page can resume tracking after a reload.

### Developer page (`app/app/settings/developer`)

- After **Seed**, the page shows a progress bar + the current step label, driven by the
  live notification for that run (and by the feed on reload). On `done` it shows the
  per-entity result table it shows today; on `failed`, the error.
- Navigating away doesn't stop the seed; the bell keeps tracking it.
- The light seed (frontend-driven) is unchanged.

### Crons (`internal/cron`)

- Each scheduler run is an activity in category `cron`: title = the cron's name, link =
  `/cron/<id>` (the cron's form), indeterminate progress, `done`/`failed` at the end.
- A failed run additionally sends a **personal** notification to the cron's run-as user
  (beside the chatter log entry it already posts).

### Adding a producer later

`notify.RegisterCategory` once, then `notify.Start` / `Progress` / `Finish` around the
work (or `notify.Personal`). The frontend needs only the category label in a `.po` file.

## 3. Live delivery — the shared live channel

The presence WebSocket (`GET /api/v1/presence`, `JWTOrCookieMiddleware`) becomes the ERP's
single live channel. Frames already carry a `type` (`snapshot`, `update`); new types are
additive and ignored by older clients:

| `type` | Payload | Sent to |
|---|---|---|
| `snapshot`, `update` | presence (unchanged) | every connection of the tenant (unchanged) |
| `notification` | the notification row as the feed returns it | targeted, see below |
| `notification_read` | `{ids}` or `{all: true}` | the same user's other connections (cross-tab sync) |

**Per-connection targeting.** At handshake each connection records `tenantID`, `userID`
and the user's allowed categories (resolved server-side). The hub gains
`Publish(notification)`:

- personal → only connections whose `userID` equals the owner;
- global → only connections of that tenant whose categories contain the category.

Filtering happens in Go before any byte is written; nothing is broadcast and filtered in
the browser. `Broadcast` keeps serving presence.

**Role changes.** When a role's categories, a role's `belongs`, or a user's roles change
(the roles/users admin handlers, `role_notification_category` PUT, `user_roles`/`role_belongs`
writes), the hub re-resolves the categories of that tenant's connected users. Cheap at the
current scale (one process, few connections); no re-login needed.

**Throttling.** `run.Progress` publishes at most every 500 ms per activity and writes the
row only when the step (label) changes; `Start`/`Finish` always write and publish.

**Disconnected tabs** miss nothing: rows are stored, and the client re-reads
`GET /api/v1/notifications` on every (re)connect.

## 4. Frontend

### Bell (`AppTopBar`, left of `CompanyLogo`)

- Icon button with an unread badge (capped "9+").
- **Breathing red dot**: appears when a new notification arrives (live), a looping
  scale/opacity pulse; stops once the panel is opened. Disabled by the Performance UI
  style and `prefers-reduced-motion`, like every other animation.
- **Panel** (popover):
  - *Running now* — in-flight activities: title, step label, determinate or
    indeterminate progress bar.
  - *Notifications* — personal messages and finished/failed activities, newest first,
    unread highlighted, failures marked red, relative time.
  - *Mark all as read*; an empty state.
- **Click** → mark read, then `router.push(erpPath(link))`.

### State

`useNotificationStore` (Zustand, not persisted — live server state, like
`usePresenceStore`): seeded by a BFF read of the feed, then kept current by the live
channel the presence client already opens (`connectPresenceSocket` dispatches the new
frame types to it). Mark-read goes through a Server Action; other tabs follow via
`notification_read` frames.

### Roles — Settings → Users → Roles

The role form gets a **Notifications** notebook page: one switch per registered category
(translated label), saved through `PUT /api/v1/roles/:id/notification_categories`,
editable only with role write rights; a hint states that personal notifications always
reach their owner.

**Defaults:** roles start with no category. The seeded admin role gets every registered
category (development works out of the box).

## Testing

Go:
- Privacy invariant at three levels — repository (another user's personal row never
  listed, never markable, ids outside the filter ignored), HTTP (two users of one tenant,
  plus a second tenant), hub (personal publish reaches only the owner's connections;
  global only connections holding the category; category re-resolution after a role
  change).
- Seed job: 202 + progress events + `done`; failure → `failed` + personal notification;
  concurrent seed → 409; boot marks a stale `running` row `failed`.
- Cron run → activity; failed run → personal notification to the run-as user.
- Retention sweep; link validation; unregistered category rejected; progress throttling.

Frontend:
- Store: feed load, live insert/update, cross-tab read sync, reconnect reload.
- Bell: badge, breathing dot appears on a live arrival and stops on open, click marks
  read and navigates.
- Roles notebook page saves categories; Developer page progress bar follows the run.

## Documentation

- ADR: notifications & the shared live channel (extends ADR-019).
- `CLAUDE.md`: an `internal/notify` bullet (API, privacy invariant, adding a category);
  `core-front/CLAUDE.md`: bell, store, roles page, developer progress.
