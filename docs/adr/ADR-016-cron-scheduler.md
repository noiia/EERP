# ADR-016: Background cron scheduler over the generic CRUD surface

**Status:** Accepted

## Context

The request was to add scheduled background actions to the application: user-creatable from
Settings, listable/kanban/calendar/graph like any other entity, running arbitrary Go code as a
chosen user with a permission check, keeping a downloadable execution history, and pruning that
history after a sliding retention window.

Several existing patterns were candidates to build on:

- `internal/chatter`/`internal/notebook`/`internal/savedfilter` — dedicated, tenant-pinned
  handlers kept OFF the generic CRUD surface, because each needs a visibility/ownership rule the
  generic column-filter chain can't express (private-or-shared, anchor-scoping, append-only).
- `internal/module`'s `RegisterGoModule`/`GoModule` — a package-level registry populated by a
  plain `init()`, the established shape for "a module contributes X at compile time."
- `crminheritdemo`/`warehouse`/`sale` — hand-mounted route overrides for the ONE verb (or few)
  that needs custom logic, while every other verb on the same table stays on the fully generic
  CRUD handler.
- The frontend's `ViewDescriptor` engine — List/Kanban/Calendar/Graph are derived automatically
  from a `viewType: 'tree'` descriptor plus `viewModeDefaults`; no bespoke renderer exists for
  any entity today.

The literal request also specified a form with exactly two custom fields on the cron itself (a
name and a single execution date) — not a recurring interval expression (minute/hour/day/month
cron syntax). "Follows the comportment of common crons" is read here as "behaves like a real
background job system" (a polling scheduler, structured run history, permission-checked
execution), not literally recurring crontab syntax the request never asked for a field for.

## Decision

### 1. `Cron`/`CronHistory` ride the generic CRUD surface, not a dedicated handler

Unlike chatter/notebook/savedfilter, neither table has a visibility rule the generic
`filter[]`/`search[]` chain can't express — every row is a plain tenant-scoped record. Registering
them via `orm.Register[cron.Cron]()` / `orm.Register[cron.CronHistory]()` (no `WithExcluded()`)
is what gives them List **and** Kanban **and** Calendar **and** Graph for free through the
existing frontend engine (`ViewDescriptor.viewModeDefaults`) — no custom list/kanban/calendar
component was written for this feature. Two small hand-mounted additions sit on top, mirroring
`crminheritdemo`'s "override only the verb that needs it" posture exactly:

- `POST`/`PUT /api/v1/cron` are overridden (`core/modules/cron/handler.go`) to resolve
  `action_code` from the registry whenever `action_id` is set — the generic CRUD handler has no
  before-write hook for that.
- `GET /api/v1/cron_history/:id/log` is a hand-mounted addition (not an override — it's a new
  path, `/api/v1/cron_history/:id` and the collection route stay fully generic) that streams a
  run's log file. It derives `cron_history:cron_history:read` from the route automatically
  (`derivePermissionFromRoute`'s existing "a static segment after `:id` folds into the method"
  rule — the same mechanism the generic `:id/restore` route already uses), so no new permission
  needed wiring.

### 2. Cron is one-shot (`ExecutionDate`), not a recurring interval

The request's own field list (name + a single date) is honored literally: `Cron.ExecutionDate`
is a nilable "run once at this instant" timestamp, cleared back to `nil` by the scheduler right
after a run so it never re-fires. An action wanting to reschedule itself is free to set a new
`ExecutionDate` as an ordinary side effect of its own `Run` — no separate recurrence mechanism
was built for a field the request never asked for.

### 3. Actions are Go code registered from a module's own `cron.go` file

`internal/cron.Register(Action{...})`, called from a package-level `init()` in a `cron.go` file —
deliberately mirrors `module.RegisterGoModule`'s exact shape (a compile-time registry populated
by import-time side effects), since that's the established "how a module contributes code to the
core" pattern in this codebase, not a new mechanism invented for this feature.
`core/modules/cron/cron.go` is both the reference implementation of that pattern AND the
concrete answer to "create a default function to remove cron_history lines and files after a
sliding year of life": it registers `cron.history_retention`, whose `Run` re-invokes the exact
sweep (`internal/cron.SweepHistory`) the scheduler already performs automatically every tick —
so an admin can ALSO trigger/schedule it manually, on top of the automatic sweep.

`Action.Source` is populated via `//go:embed cron.go` in the registering file itself, so the
form's read-only "Code" notebook page always shows the REAL Go source that runs, never a
hand-written description that can drift from it.

### 4. `ActionID` is not validated against the registry at write time

The generic CRUD surface has no per-field validation hook to check `action_id` against the
registry when a cron is created or edited. Rather than build a bespoke validation layer for this
one field, an unknown `action_id` is left to fail exactly like any other run-time problem: the
scheduler records a failed `CronHistory` row naming the missing action, visible immediately in
the calendar (red) and the run's own log. One failure path instead of two.

### 5. Run-as-user permission failures surface via the record's own chatter feed

A background scheduler has no live HTTP caller to return an error to. `internal/chatter` is
already the engine's channel for "the system told me something about this record" (the form
chatter panel, `core-front/CLAUDE.md`'s Form chatter panel row) — so a missing-permission run
posts a `kind: "log"` chatter message on the cron's own record, naming the run-as user, the
action, and the missing permission, satisfying "system emit an error message to the user and
tells on which action the user doesn't have the rights" without inventing a second notification
channel (email, a dedicated inbox) nothing else in the codebase has yet.

### 6. Local disk for log files, not S3

`cron_history.logs_filepath` is a plain string, and the request never asked for object storage.
Unlike `internal/pictures` (which needs S3 for durability/CDN properties a user-facing image
benefits from), a cron run's log is small, workspace-internal text — `Config.CronLogDir` (default
`cron_logs`, resolved the same way `module_root` is) keeps the feature available with zero extra
infra, at the cost of the log files not surviving a redeploy onto different storage/host without
being carried along manually (acceptable: unlike a picture, a lost log is not user data, just a
debugging aid retention already prunes on its own schedule).

### 7. One poll loop does both scheduling and retention

`Scheduler.Run` ticks once a minute (cron's own traditional granularity) and, each tick, both
runs due crons and calls `SweepHistory`. `// ponytail: piggybacking retention on the same ticker
trades sweep-timing precision for one goroutine instead of two — a dedicated daily timer is the
upgrade path if the sweep ever needs to avoid a specific busy window.` Retention itself is a HARD
delete (`orm.Repository.HardDelete`), not the ORM's default soft delete — "remove... lines and
files" means actually gone, and a soft-deleted row hidden behind `deleted_at` would still count
as "life" by any measure that matters for reclaiming space.

### 8. `calendarColorField`: a small, generic engine addition, not a cron-only hack

"If a cron has failed, display it as red" needed the Calendar renderer to color a card from a
boolean field's value — a capability the engine didn't have. Rather than special-case cron inside
`calendar-renderer.tsx`, `ViewModeDefaults.calendarColorField?: string` was added as a generic,
module-declared hint (a `true`-valued named boolean field renders its card with a red accent) any
future entity can reuse. It has no runtime admin-override path (unlike `kanbanStatusField`/
`calendarDateField`) — it is a fixed semantic a module states once, not a workspace preference.

## Deliberate cuts (ponytail)

- **No recurring schedule / cron-expression field.** See Decision #2 — the request's own field
  list didn't ask for one; add an interval field + reschedule logic if recurring crons become a
  real requirement.
- **No manual "Run now" trigger.** The scheduler's own polling loop already covers "runs on
  schedule"; a manual trigger is a real, common cron-admin convenience but wasn't asked for and
  needs its own endpoint (`POST /api/v1/cron/:id/run`) — a reasonable next slice, not built here.
- **Kanban's "archived" column is not hidden by default.** The request asked for exactly that,
  but the engine's Kanban renderer has no per-column visibility toggle today (columns are simply
  every `selection.options` value, in declared order, plus a trailing "No status" column) — adding
  one is a real engine feature in its own right, out of scope for this change. `archived` is
  declared LAST in `status`'s options instead, the closest available approximation (it lands as
  the trailing, least-prominent column) without inventing new Kanban machinery.
- **`ActionID` is a plain text field, not a live dropdown of registered actions.** The frontend
  has no route to ask Go "what actions exist" at descriptor-registration time (descriptors are
  static TypeScript); building one (a new lookup endpoint + relation-like widget) for a single
  text field was judged not worth it given actions fail loudly and immediately (Decision #4) when
  mistyped.
- **`HistoryRetentionYears` lives on `Cron` itself, per row**, not as a single workspace-wide
  `app_settings` value. The request's own wording ("add a field on the cron settings to change
  this value") reads more naturally as a field on the cron's own form than a new global Settings
  screen, and it sidesteps `internal/settings`' per-company scoping (a background job has no
  "current company" the way an HTTP request does).

## Consequences

- Adding a genuinely recurring schedule later means adding an interval field to `Cron` and
  teaching the scheduler to compute the next `ExecutionDate` after a run instead of clearing it —
  additive, no migration of existing one-shot rows required (their behavior is unchanged: a
  cron with no interval field set just keeps behaving as "run once").
- `action_id` typos are only caught by the FIRST scheduled run failing, not at creation time — an
  accepted tradeoff (Decision #4), visible immediately via the calendar/history/chatter.
- Cron log files live on local disk, so a multi-instance backend deployment needs a shared volume
  (or a switch to object storage, mirroring `internal/pictures`) for downloads to work from every
  instance — not a concern for the single-instance deployment this codebase currently targets.

## Reference implementation

`core/internal/cron/` (`models.go`, `registry.go`, `env.go`, `scheduler.go`, `retention.go`,
`logstore.go`, `handler.go`, `repository.go`), `core/modules/cron/` (`module.go`, `handler.go`,
`cron.go` — the reference `cron.go` action + the retention `Register` call, `views/CronViews.ts`),
`core/cmd/app/main.go` (wiring + `cron.SetEnv` + `go cronScheduler.Run(ctx)`),
`core-front/packages/core-front/src/api/view-fields.ts` (`calendarColorField`),
`core-front/packages/core-front/src/views/calendar-renderer.tsx` (`colorField` prop),
`core-front/apps/shell/app/api/cron-history/[id]/log/route.ts` (BFF download proxy),
`core-front/apps/shell/src/components/DeveloperSettings.tsx` (Settings → Developer → Crons).
