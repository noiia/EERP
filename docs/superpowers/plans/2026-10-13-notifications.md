# Notifications & Live Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A core notification system — global activities (crons, demo-data seeding, …) with live progress, plus private per-user notifications — shown under a bell in the ERP top bar, with role-managed visibility and a live progress loader on the full seed.

**Architecture:** `core/internal/notify` owns three tables, a Go API (`Personal`, `Start`/`Progress`/`Finish`) and two HTTP routes. Each publish computes its **audience** (an explicit set of user ids) server-side — the owner for a personal notification, every user whose role closure holds the category for a global one — and the presence WebSocket hub sends it only to those users' connections. The frontend keeps a non-persisted Zustand store fed by one BFF read and the existing presence socket.

**Tech Stack:** Go (echo v5, pgx through `core/orm`, gorilla/websocket), Postgres; Next.js App Router + MUI + Zustand; vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-13-notifications-design.md`

## Refinements of the spec (decided while planning — flag in review)

1. **Audience instead of per-connection category caches.** The spec had each connection cache its categories and re-resolve them on role changes. Instead every global publish resolves its audience with one SQL query over the role closure (`Repository.Audience`), and the hub only sends to explicit user ids (`Hub.SendToUsers`). Always current after any role/membership change, no change hooks needed, and the hub never decides visibility itself.
2. **Role categories ride the existing catalog + junction pattern** (like `account_role_types` + `role_view_permission_right`): a per-tenant `notification_category` catalog seeded from the Go registry at boot, and a `role_notification_category` junction on the generic CRUD surface. The role form's **Notifications** tab is then a stock many2many tags field — no bespoke switches, no dedicated `GET|PUT /roles/:id/notification_categories` endpoint, and no `GET /notification_categories` endpoint (the tags widget reads the catalog through the generic API). Permissions derive from the routes as for `role_belongs`/`user_roles` (the Admin role's `*:*:*` covers them).
3. **`data` column.** Notifications carry an optional opaque JSON `data` (text). The seed's `done` activity stores its per-entity results there so the Developer page can show its result table after a background run.

## Global Constraints

- Retention: finished global activities **7 days**; personal notifications **30 days**; `running` rows never swept.
- Privacy invariant on every read/write path: `tenant_id = caller.tenant AND (user_id = caller.user OR (user_id IS NULL AND category = ANY(caller.categories)))`; no route takes another user's id; ids outside the filter are silently ignored by mark-read.
- `link` must be an ERP-relative path: starts with exactly one `/` (not `//`), no `\`; otherwise `notify` rejects the call.
- Categories: `cron` → "Scheduled actions", `dev_seed` → "Demo data seeding"; an unregistered category is an error.
- Progress publishes at most every **500 ms** per activity; the row is written only when the label changes; `Start`/`Finish` always write and publish.
- Live frames on the presence socket: `{"type":"notification","notification":{…}}` and `{"type":"notification_read","ids":[…]}` / `{"type":"notification_read","all":true}`; presence frames unchanged.
- One full seed per tenant at a time (409 while one runs). `POST /api/v1/dev_seed` answers `202 {"notification_id": "<uuid>"}`.
- Roles start with no category, except the seeded `admin` role, which receives each category the first time the category appears in a tenant's catalog.
- Go: no `fmt`/`log` printing (zap via `common.Logger`), table-driven tests, interfaces at the call site. Search with `rg`. Tests use `-timeout`.
- Frontend: every file ships with tests; animations disabled under Performance UI style and `prefers-reduced-motion`; module views untouched by Prettier.
- Toolchain on this machine: `export PATH=$PATH:/usr/local/go/bin`; pnpm as `npx -y pnpm@12.4.2`; DB tests need `TEST_DSN` or `CONFIG=/home/noia/development/EERP/eerp-config.json`; rebuild the engine (`npx -y pnpm@12.4.2 --filter @eerp/core-front build`) before shell tests.

## Review Focus

1. **Another user's personal notification reaching a browser** — through the feed, mark-read, or a live frame. Pinned by Task 2 (repository), Task 4 (handler, two users) and Task 3 (hub sends only to the given ids).
2. **A user whose role loses a category keeps receiving it** — the audience must be re-resolved on every publish. Pinned in Task 2 (`Audience` after deleting the junction row).
3. **A seed failing in the background leaves the UI spinning forever** — `Finish(err)` must always run (deferred), and a restart marks stale `running` rows failed. Pinned in Task 5 (failing seed) and Task 3 (`FailInterrupted`).
4. **A malicious or malformed `link`** (`//evil.example`, `https://…`, `javascript:`) turning a notification into an open redirect. Pinned in Task 3 (`validLink` table) and Task 8 (the bell only `router.push`es `erpPath(link)`).
5. **Two tabs of one user** — reading in one must clear the dot/badge in the other, and the dot must not breathe for a notification the user already saw. Pinned in Task 7 (store applies `notification_read` frames) and Task 8 (dot stops on open).

---

## File Structure

Backend (`core/`):

| File | Responsibility |
|---|---|
| `internal/notify/models.go` | `Notification`, `NotificationRead`, `NotificationCategory`, `RoleNotificationCategory` structs |
| `internal/notify/categories.go` | `RegisterCategory`, `Categories`, `IsCategory` (process-global registry) |
| `internal/notify/repository.go` | tenant/user-scoped SQL: create/update, feed, mark read, audience, caller categories, sweep, fail-interrupted, catalog sync |
| `internal/notify/service.go` | `Service`: `Personal`, `Start`, `Run.Progress/Finish`, publishing, throttling, link validation |
| `internal/notify/handler.go` | `GET /api/v1/notifications`, `POST /api/v1/notifications/read` |
| `internal/notify/sweeper.go` | `Sweep` (retention) |
| `modules/notify/module.go` | ORM registration, indexes, catalog sync per tenant, admin defaults |
| `internal/presence/hub.go` | + `SendToUsers` |
| `internal/devseed/{seed.go,handler.go,job.go}` | progress callback, `Validate`, background job |
| `internal/cron/scheduler.go` | + notifier |
| `internal/app/app.go` | wiring |

Frontend (`core-front/`):

| File | Responsibility |
|---|---|
| `packages/core-front/src/views/notification-store.ts` | `useNotificationStore` (feed, unread, `hasNew`), frame handling |
| `packages/core-front/src/views/presence-store.ts` | dispatch `notification*` frames to the store; reload feed on (re)connect |
| `apps/shell/src/lib/notification-actions.ts` | Server Actions `loadNotifications`, `markNotificationsRead`, `revalidateSeededEntities` |
| `apps/shell/src/components/NotificationBell.tsx` | bell, badge, breathing dot, panel |
| `apps/shell/src/components/AppTopBar.tsx` | mount the bell left of `CompanyLogo` |
| `apps/shell/src/components/ErpUiStyle.tsx` | `erp-breathe` keyframes |
| `apps/shell/app/app/settings/users/descriptors.ts` | role `notifications` m2m + "Notifications" notebook page |
| `apps/shell/src/lib/dev-seed.ts`, `src/components/DeveloperSettings.tsx` | 202 flow + progress |

---

### Task 1: Category registry and data model

**Files:**
- Create: `core/internal/notify/models.go`, `core/internal/notify/categories.go`, `core/internal/notify/categories_test.go`
- Create: `core/modules/notify/module.go`, `core/modules/notify/module.json`, `core/modules/notify/module_test.go`
- Modify: `core/modules/all/all.go` (blank import)

**Interfaces:**
- Produces: `notify.Category{Key, Label string}`; `notify.RegisterCategory(Category)`; `notify.Categories() []Category` (registration order); `notify.IsCategory(key string) bool`; structs `Notification`, `NotificationRead`, `NotificationCategory`, `RoleNotificationCategory` (fields below); module name `"notify"`.

- [ ] **Step 1: Write the failing registry test**

`core/internal/notify/categories_test.go`:
```go
package notify

import "testing"

func TestRegisterCategory(t *testing.T) {
	RegisterCategory(Category{Key: "test_cat", Label: "Test category"})
	RegisterCategory(Category{Key: "test_cat", Label: "Renamed"}) // re-registering updates, never duplicates

	tests := []struct {
		name string
		key  string
		want bool
	}{
		{"registered", "test_cat", true},
		{"built-in cron", "cron", true},
		{"built-in seed", "dev_seed", true},
		{"unknown", "nope", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsCategory(tc.key); got != tc.want {
				t.Errorf("IsCategory(%q) = %v, want %v", tc.key, got, tc.want)
			}
		})
	}
	n := 0
	for _, c := range Categories() {
		if c.Key == "test_cat" {
			n++
			if c.Label != "Renamed" {
				t.Errorf("label = %q, want Renamed", c.Label)
			}
		}
	}
	if n != 1 {
		t.Errorf("test_cat listed %d times", n)
	}
}
```

- [ ] **Step 2: Run it — expect a compile failure** (`RegisterCategory` undefined)

Run: `cd core && go test ./internal/notify/ -run TestRegisterCategory -timeout 2m`

- [ ] **Step 3: Implement the registry and models**

`core/internal/notify/categories.go`:
```go
package notify

import "sync"

// Category is a kind of global activity a role can be allowed to see
// (Settings → Users → Roles → Notifications). Label is an English msgid,
// translated by the frontend.
type Category struct {
	Key   string
	Label string
}

var (
	catMu      sync.Mutex
	categories []Category
)

func init() {
	RegisterCategory(Category{Key: "cron", Label: "Scheduled actions"})
	RegisterCategory(Category{Key: "dev_seed", Label: "Demo data seeding"})
}

// RegisterCategory declares a category, at init() like mail.RegisterTemplate.
// Registering a key again updates its label.
func RegisterCategory(c Category) {
	catMu.Lock()
	defer catMu.Unlock()
	for i := range categories {
		if categories[i].Key == c.Key {
			categories[i] = c
			return
		}
	}
	categories = append(categories, c)
}

// Categories lists every registered category in registration order.
func Categories() []Category {
	catMu.Lock()
	defer catMu.Unlock()
	return append([]Category(nil), categories...)
}

// IsCategory reports whether key was registered.
func IsCategory(key string) bool {
	for _, c := range Categories() {
		if c.Key == key {
			return true
		}
	}
	return false
}
```

`core/internal/notify/models.go`:
```go
// Package notify is the core notification system: global activities (a cron
// run, a demo-data seed…) with live progress, visible to the roles allowed the
// activity's category, and personal notifications visible to their owner only.
// See docs/adr/ADR-031-notifications.md.
package notify

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// Notification is one personal message (UserID set) or global activity
// (UserID nil). Off the generic CRUD surface: only the privacy-filtered
// handlers in this package read it.
type Notification struct {
	model.BaseModel
	UserID        *uuid.UUID `db:"user_id" json:"-"`
	Category      string     `db:"category" json:"category"`
	Kind          string     `db:"kind" json:"kind"` // "message" | "activity"
	Title         string     `db:"title" json:"title"`
	Body          string     `db:"body" json:"body"`
	Link          string     `db:"link" json:"link"`
	Status        *string    `db:"status" json:"status"` // activities: running|done|failed
	Progress      *int       `db:"progress" json:"progress"`
	ProgressLabel *string    `db:"progress_label" json:"progress_label"`
	ActorID       *uuid.UUID `db:"actor_id" json:"-"`
	FinishedAt    *time.Time `db:"finished_at" json:"finished_at"`
	// Data is opaque JSON for the page the notification links to (e.g. a
	// seed's per-entity results). Never interpreted server-side.
	Data *string `db:"data" json:"data"`
}

// NotificationRead marks one notification read for one user.
type NotificationRead struct {
	model.BaseModel
	UserID         uuid.UUID `db:"user_id"`
	NotificationID uuid.UUID `db:"notification_id"`
	ReadAt         time.Time `db:"read_at"`
}

// NotificationCategory is a tenant's copy of a registered Category — the
// catalog the role form's Notifications tags widget offers (synced at boot,
// modules/notify).
type NotificationCategory struct {
	model.BaseModel
	Key   string `db:"key" json:"key"`
	Label string `db:"label" json:"label"`
	// Name mirrors Label so the stock relation widgets (labelField "name") read it.
	Name string `db:"name" json:"name"`
}

// RoleNotificationCategory allows a role (and every role belonging to it) the
// global activities of one category. Rides the generic CRUD surface like
// role_belongs, so the role form needs no bespoke endpoint.
type RoleNotificationCategory struct {
	model.BaseModel
	RoleID                 uuid.UUID `db:"role_id" json:"role_id"`
	NotificationCategoryID uuid.UUID `db:"notification_category_id" json:"notification_category_id"`
}
```

- [ ] **Step 4: Run the registry test — expect PASS**

Run: `cd core && go test ./internal/notify/ -run TestRegisterCategory -timeout 2m`

- [ ] **Step 5: Write the failing module test**

`core/modules/notify/module_test.go`:
```go
package notify_test

import (
	"context"
	"testing"

	"core/internal/notify"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/notify"

	"github.com/google/uuid"
)

// Boot syncs every registered category into each tenant's catalog and gives
// the admin role each category the first time it appears — but never re-adds
// one an admin removed later.
func TestMigrate_SyncsCatalogAndAdminDefaults(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	tenant := uuid.New()
	adminRole := uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{"role_notification_category", "notification_category", "roles", "users"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	testdb.MigrateModules(t, app, "auth")
	if _, err := app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`, uuid.New(), tenant, uuid.NewString()+"@t.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO roles (id, tenant_id, name, technical_name) VALUES ($1, $2, 'Admin', 'admin')`, adminRole, tenant); err != nil {
		t.Fatal(err)
	}

	testdb.MigrateModules(t, app, "notify")

	var cats, granted int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM notification_category WHERE tenant_id = $1 AND deleted_at IS NULL`, tenant).Scan(&cats)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM role_notification_category WHERE role_id = $1 AND deleted_at IS NULL`, adminRole).Scan(&granted)
	if want := len(notify.Categories()); cats != want || granted != want {
		t.Fatalf("catalog = %d, admin grants = %d, want %d each", cats, granted, want)
	}

	// An admin unticks "cron"; the next boot must not re-add it.
	if _, err := app.DB.Exec(ctx, `DELETE FROM role_notification_category rnc USING notification_category c
		WHERE rnc.notification_category_id = c.id AND c.key = 'cron' AND rnc.role_id = $1`, adminRole); err != nil {
		t.Fatal(err)
	}
	testdb.MigrateModules(t, app, "notify")
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM role_notification_category WHERE role_id = $1 AND deleted_at IS NULL`, adminRole).Scan(&granted)
	if granted != len(notify.Categories())-1 {
		t.Errorf("admin grants after reboot = %d, want %d (cron stays removed)", granted, len(notify.Categories())-1)
	}
}
```

- [ ] **Step 6: Run it — expect a compile failure** (`core/modules/notify` missing)

Run: `cd core && TEST_DSN=… go test ./modules/notify/ -timeout 5m` (or `CONFIG=/home/noia/development/EERP/eerp-config.json`)

- [ ] **Step 7: Implement the module**

`core/modules/notify/module.json`:
```json
{
    "active": true,
    "type": "go",
    "name": "notify",
    "display_name": "Notifications",
    "version": "0.0.1",
    "author": "Edwin Lecomte",
    "description": "Core notifications: global activities and personal notifications.",
    "depends": ["auth"],
    "app_mode": false,
    "static_files": {},
    "is_service": false,
    "auto_install": true
}
```

`core/modules/notify/module.go`:
```go
// Package notify registers the notification tables and keeps every tenant's
// category catalog in step with the Go registry. Import via core/modules/all.
package notify

import (
	"context"
	"fmt"

	"core/internal/module"
	inotify "core/internal/notify"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&notifyModule{})
}

type notifyModule struct{}

func (m *notifyModule) Name() string { return "notify" }

func (m *notifyModule) Register() error {
	// notification / notification_read stay OFF the generic CRUD surface: only
	// the privacy-filtered handlers in internal/notify may read them.
	if err := orm.Register[inotify.Notification](orm.WithTableName("notification"), orm.WithExcluded()); err != nil {
		return err
	}
	if err := orm.Register[inotify.NotificationRead](orm.WithTableName("notification_read"), orm.WithExcluded()); err != nil {
		return err
	}
	// The catalog and the role junction ride the generic CRUD surface (the
	// role form's tags widget), like account_role_types / role_belongs.
	if err := orm.Register[inotify.NotificationCategory](orm.WithTableName("notification_category")); err != nil {
		return err
	}
	return orm.Register[inotify.RoleNotificationCategory](orm.WithTableName("role_notification_category"))
}

func (m *notifyModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, ddl := range []string{
		`CREATE INDEX IF NOT EXISTS idx_notification_user ON notification (tenant_id, user_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_notification_global ON notification (tenant_id, category, created_at DESC) WHERE user_id IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_read_user ON notification_read (user_id, notification_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_category_key ON notification_category (tenant_id, key) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_notification_category ON role_notification_category (role_id, notification_category_id) WHERE deleted_at IS NULL`,
	} {
		if _, err := db.Exec(ctx, ddl); err != nil {
			return fmt.Errorf("notify: migrate: %w", err)
		}
	}
	return inotify.NewRepository(db).SyncCatalog(ctx)
}
```

Add to `core/internal/notify/repository.go` (created here, extended in Task 2):
```go
package notify

import (
	"context"
	"fmt"

	"core/orm"
)

// Repository is the notification store. Every read is tenant- and
// user-scoped (see Feed); nothing here lists another user's personal rows.
type Repository struct {
	db *orm.DB
}

// NewRepository wires the store.
func NewRepository(db *orm.DB) *Repository { return &Repository{db: db} }

// SyncCatalog copies every registered category into each known tenant's
// catalog (a tenant = one with a live user). A category new to a tenant is
// also granted to that tenant's "admin" role — only then, so an admin who
// later removes it doesn't see it come back on the next boot.
func (r *Repository) SyncCatalog(ctx context.Context) error {
	for _, c := range Categories() {
		rows, err := r.db.Query(ctx, `
			INSERT INTO notification_category (tenant_id, key, label, name)
			SELECT DISTINCT u.tenant_id, $1, $2, $2 FROM users u
			WHERE u.deleted_at IS NULL
			  AND NOT EXISTS (SELECT 1 FROM notification_category nc
			                  WHERE nc.tenant_id = u.tenant_id AND nc.key = $1 AND nc.deleted_at IS NULL)
			RETURNING id, tenant_id`, c.Key, c.Label)
		if err != nil {
			return fmt.Errorf("notify: sync catalog %s: %w", c.Key, err)
		}
		type added struct{ id, tenant any }
		var news []added
		for rows.Next() {
			var a added
			if err := rows.Scan(&a.id, &a.tenant); err != nil {
				rows.Close()
				return err
			}
			news = append(news, a)
		}
		rows.Close()
		for _, a := range news {
			if _, err := r.db.Exec(ctx, `
				INSERT INTO role_notification_category (tenant_id, role_id, notification_category_id)
				SELECT $1, r.id, $2 FROM roles r
				WHERE r.tenant_id = $1 AND r.technical_name = 'admin' AND r.deleted_at IS NULL`, a.tenant, a.id); err != nil {
				return fmt.Errorf("notify: admin default %s: %w", c.Key, err)
			}
		}
		// Labels follow the registry.
		if _, err := r.db.Exec(ctx, `UPDATE notification_category SET label = $2, name = $2 WHERE key = $1 AND label <> $2`, c.Key, c.Label); err != nil {
			return fmt.Errorf("notify: relabel %s: %w", c.Key, err)
		}
	}
	return nil
}
```

Add `_ "core/modules/notify"` to `core/modules/all/all.go` (alphabetical position, after `core/modules/mail` or wherever `n` sorts).

- [ ] **Step 8: Run both tests — expect PASS**

Run: `cd core && go test ./internal/notify/ ./modules/notify/ -timeout 5m` (with `TEST_DSN`)

- [ ] **Step 9: Commit**

```bash
git add core/internal/notify core/modules/notify core/modules/all/all.go
git commit -m "feat(notify): notification tables, category registry and per-tenant catalog"
```

---

### Task 2: Repository — feed, mark read, audience, retention (the privacy boundary)

**Files:**
- Modify: `core/internal/notify/repository.go`
- Create: `core/internal/notify/repository_db_test.go`

**Interfaces:**
- Consumes: Task 1 models and tables.
- Produces (all on `*Repository`):
  - `Create(ctx, n Notification) (Notification, error)`
  - `UpdateActivity(ctx, id uuid.UUID, set ActivityUpdate) (Notification, error)` with `type ActivityUpdate struct { Status *string; Progress *int; ProgressLabel *string; Body *string; Data *string; Finished bool }`
  - `CallerCategories(ctx, tenant, user uuid.UUID) ([]string, error)`
  - `Audience(ctx, tenant uuid.UUID, category string) ([]uuid.UUID, error)`
  - `Feed(ctx, tenant, user uuid.UUID) ([]FeedItem, int, error)` — items + unread count; `type FeedItem struct { Notification; Read bool `json:"read"` }`
  - `MarkRead(ctx, tenant, user uuid.UUID, ids []uuid.UUID, all bool) ([]uuid.UUID, error)` — returns the ids actually marked (only visible ones)
  - `Sweep(ctx, now time.Time) (int64, error)`
  - `FailInterrupted(ctx) (int64, error)`
  - `RunningActivity(ctx, tenant uuid.UUID, category string) (*Notification, error)` — newest running global activity of that category, nil if none

- [ ] **Step 1: Write the failing DB tests**

`core/internal/notify/repository_db_test.go`:
```go
package notify_test

import (
	"context"
	"testing"
	"time"

	"core/internal/notify"
	"core/internal/testdb"
	"core/orm/model"
	_ "core/modules/auth"
	_ "core/modules/notify"

	"github.com/google/uuid"
)

type fixture struct {
	repo                *notify.Repository
	tenant, other       uuid.UUID
	alice, bob, outside uuid.UUID // alice: role with "cron" via belongs; bob: no category; outside: other tenant
	cronRoleLink        uuid.UUID // role_notification_category row giving cron
}

func setup(t *testing.T) fixture {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "notify")
	ctx := context.Background()
	f := fixture{repo: notify.NewRepository(app.DB), tenant: uuid.New(), other: uuid.New(),
		alice: uuid.New(), bob: uuid.New(), outside: uuid.New()}
	t.Cleanup(func() {
		for _, table := range []string{"notification_read", "notification", "role_notification_category",
			"notification_category", "role_belongs", "user_roles", "roles", "users"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = ANY($1)`, []uuid.UUID{f.tenant, f.other})
		}
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := app.DB.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	for _, u := range []struct{ id, tenant uuid.UUID }{{f.alice, f.tenant}, {f.bob, f.tenant}, {f.outside, f.other}} {
		exec(`INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`, u.id, u.tenant, uuid.NewString()+"@t.example")
	}
	// alice -> "ops" role, which belongs to "watchers"; "watchers" holds cron.
	ops, watchers, cat := uuid.New(), uuid.New(), uuid.New()
	f.cronRoleLink = uuid.New()
	exec(`INSERT INTO roles (id, tenant_id, name) VALUES ($1, $3, 'Ops'), ($2, $3, 'Watchers')`, ops, watchers, f.tenant)
	exec(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, f.tenant, f.alice, ops)
	exec(`INSERT INTO role_belongs (tenant_id, role_id, belongs_to_role_id) VALUES ($1, $2, $3)`, f.tenant, ops, watchers)
	exec(`INSERT INTO notification_category (id, tenant_id, key, label, name) VALUES ($1, $2, 'cron', 'Scheduled actions', 'Scheduled actions')`, cat, f.tenant)
	exec(`INSERT INTO role_notification_category (id, tenant_id, role_id, notification_category_id) VALUES ($1, $2, $3, $4)`, f.cronRoleLink, f.tenant, watchers, cat)
	return f
}

func create(t *testing.T, f fixture, tenant uuid.UUID, owner *uuid.UUID, category string) notify.Notification {
	t.Helper()
	n, err := f.repo.Create(context.Background(), notify.Notification{
		BaseModel: model.BaseModel{TenantID: tenant}, UserID: owner, Category: category,
		Kind: "message", Title: "t", Link: "/x",
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func ids(items []notify.FeedItem) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{}
	for _, it := range items {
		out[it.ID] = true
	}
	return out
}

func TestFeed_PrivacyAndCategories(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	alicePersonal := create(t, f, f.tenant, &f.alice, "dev_seed")
	bobPersonal := create(t, f, f.tenant, &f.bob, "dev_seed")
	cronGlobal := create(t, f, f.tenant, nil, "cron")
	seedGlobal := create(t, f, f.tenant, nil, "dev_seed")
	otherTenantGlobal := create(t, f, f.other, nil, "cron")

	tests := []struct {
		name     string
		tenant   uuid.UUID
		user     uuid.UUID
		visible  []uuid.UUID
		excluded []uuid.UUID
	}{
		{"alice sees her own and cron globals (inherited via belongs)", f.tenant, f.alice,
			[]uuid.UUID{alicePersonal.ID, cronGlobal.ID},
			[]uuid.UUID{bobPersonal.ID, seedGlobal.ID, otherTenantGlobal.ID}},
		{"bob sees only his own", f.tenant, f.bob,
			[]uuid.UUID{bobPersonal.ID},
			[]uuid.UUID{alicePersonal.ID, cronGlobal.ID, seedGlobal.ID, otherTenantGlobal.ID}},
		{"another tenant sees nothing of this one", f.other, f.outside,
			nil,
			[]uuid.UUID{alicePersonal.ID, bobPersonal.ID, cronGlobal.ID, seedGlobal.ID, otherTenantGlobal.ID}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			items, unread, err := f.repo.Feed(ctx, tc.tenant, tc.user)
			if err != nil {
				t.Fatal(err)
			}
			got := ids(items)
			for _, id := range tc.visible {
				if !got[id] {
					t.Errorf("missing %s", id)
				}
			}
			for _, id := range tc.excluded {
				if got[id] {
					t.Errorf("leaked %s", id)
				}
			}
			if unread != len(tc.visible) {
				t.Errorf("unread = %d, want %d", unread, len(tc.visible))
			}
		})
	}
}

func TestMarkRead_OnlyVisibleRows(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	alicePersonal := create(t, f, f.tenant, &f.alice, "dev_seed")
	bobPersonal := create(t, f, f.tenant, &f.bob, "dev_seed")

	// Bob tries to mark Alice's personal notification read: silently ignored.
	marked, err := f.repo.MarkRead(ctx, f.tenant, f.bob, []uuid.UUID{alicePersonal.ID, bobPersonal.ID}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(marked) != 1 || marked[0] != bobPersonal.ID {
		t.Fatalf("marked = %v, want only bob's own", marked)
	}
	items, unread, _ := f.repo.Feed(ctx, f.tenant, f.alice)
	if unread != 1 || items[0].Read {
		t.Errorf("alice's notification must stay unread for her, unread=%d", unread)
	}
	// "all" marks only what the caller can see.
	if _, err := f.repo.MarkRead(ctx, f.tenant, f.alice, nil, true); err != nil {
		t.Fatal(err)
	}
	if _, unread, _ := f.repo.Feed(ctx, f.tenant, f.alice); unread != 0 {
		t.Errorf("alice unread after all = %d", unread)
	}
	if _, unread, _ := f.repo.Feed(ctx, f.tenant, f.bob); unread != 0 {
		t.Errorf("bob unread = %d (his was already read)", unread)
	}
}

func TestAudience_FollowsRoleChanges(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	got, err := f.repo.Audience(ctx, f.tenant, "cron")
	if err != nil || len(got) != 1 || got[0] != f.alice {
		t.Fatalf("audience = %v, %v; want [alice]", got, err)
	}
	if aud, _ := f.repo.Audience(ctx, f.tenant, "dev_seed"); len(aud) != 0 {
		t.Errorf("dev_seed audience = %v, want none", aud)
	}
	// Removing the category from the role takes effect on the next publish.
	if _, err := f.repo.DB().Exec(ctx, `UPDATE role_notification_category SET deleted_at = now() WHERE id = $1`, f.cronRoleLink); err != nil {
		t.Fatal(err)
	}
	if aud, _ := f.repo.Audience(ctx, f.tenant, "cron"); len(aud) != 0 {
		t.Errorf("audience after removal = %v, want none", aud)
	}
}

func TestSweepAndFailInterrupted(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	running, done := "running", "done"
	old := time.Now().Add(-40 * 24 * time.Hour)
	mk := func(owner *uuid.UUID, status *string, finished *time.Time) uuid.UUID {
		n, err := f.repo.Create(ctx, notify.Notification{BaseModel: model.BaseModel{TenantID: f.tenant},
			UserID: owner, Category: "cron", Kind: "activity", Title: "t", Link: "/x", Status: status, FinishedAt: finished})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.repo.DB().Exec(ctx, `UPDATE notification SET created_at = $2 WHERE id = $1`, n.ID, old); err != nil {
			t.Fatal(err)
		}
		return n.ID
	}
	oldGlobalDone := mk(nil, &done, &old)
	oldRunning := mk(nil, &running, nil)
	oldPersonal := mk(&f.alice, nil, nil)
	recentPersonal := create(t, f, f.tenant, &f.alice, "cron").ID

	if _, err := f.repo.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	exists := func(id uuid.UUID) bool {
		var n int
		_ = f.repo.DB().QueryRow(ctx, `SELECT count(*) FROM notification WHERE id = $1`, id).Scan(&n)
		return n == 1
	}
	if exists(oldGlobalDone) || exists(oldPersonal) {
		t.Error("expired rows must be swept")
	}
	if !exists(oldRunning) || !exists(recentPersonal) {
		t.Error("running and recent rows must stay")
	}
	if n, err := f.repo.FailInterrupted(ctx); err != nil || n < 1 {
		t.Fatalf("FailInterrupted = %d, %v", n, err)
	}
	var status string
	_ = f.repo.DB().QueryRow(ctx, `SELECT status FROM notification WHERE id = $1`, oldRunning).Scan(&status)
	if status != "failed" {
		t.Errorf("interrupted status = %q, want failed", status)
	}
}
```

- [ ] **Step 2: Run them — expect compile failures** (`Feed`, `MarkRead`, … undefined)

Run: `cd core && go test ./internal/notify/ -timeout 5m`

- [ ] **Step 3: Implement the repository**

Append to `core/internal/notify/repository.go` (add imports `time`, `github.com/google/uuid`):
```go
// DB exposes the pool to tests and to the module's Migrate.
func (r *Repository) DB() *orm.DB { return r.db }

// columns and nColumns list the same columns in the same order — scanNotification's.
const columns = `id, tenant_id, created_at, updated_at, deleted_at, user_id, category, kind, title, body, link,
	status, progress, progress_label, actor_id, finished_at, data`

const nColumns = `n.id, n.tenant_id, n.created_at, n.updated_at, n.deleted_at, n.user_id, n.category, n.kind, n.title,
	n.body, n.link, n.status, n.progress, n.progress_label, n.actor_id, n.finished_at, n.data`

func scanNotification(row interface{ Scan(...any) error }) (Notification, error) {
	var n Notification
	err := row.Scan(&n.ID, &n.TenantID, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt, &n.UserID, &n.Category, &n.Kind,
		&n.Title, &n.Body, &n.Link, &n.Status, &n.Progress, &n.ProgressLabel, &n.ActorID, &n.FinishedAt, &n.Data)
	return n, err
}

// Create inserts n and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, n Notification) (Notification, error) {
	row := r.db.QueryRow(ctx, `
		INSERT INTO notification (tenant_id, user_id, category, kind, title, body, link, status, progress, progress_label, actor_id, data)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		RETURNING `+columns,
		n.TenantID, n.UserID, n.Category, n.Kind, n.Title, n.Body, n.Link, n.Status, n.Progress, n.ProgressLabel, n.ActorID, n.Data)
	out, err := scanNotification(row)
	if err != nil {
		return Notification{}, fmt.Errorf("notify: create: %w", err)
	}
	return out, nil
}

// ActivityUpdate is a partial update of an activity row; nil fields are kept.
type ActivityUpdate struct {
	Status        *string
	Progress      *int
	ProgressLabel *string
	Body          *string
	Data          *string
	Finished      bool
}

// UpdateActivity applies u to the activity id and returns the row.
func (r *Repository) UpdateActivity(ctx context.Context, id uuid.UUID, u ActivityUpdate) (Notification, error) {
	row := r.db.QueryRow(ctx, `
		UPDATE notification SET
			status = COALESCE($2, status),
			progress = COALESCE($3, progress),
			progress_label = COALESCE($4, progress_label),
			body = COALESCE($5, body),
			data = COALESCE($6, data),
			finished_at = CASE WHEN $7 THEN now() ELSE finished_at END,
			updated_at = now()
		WHERE id = $1
		RETURNING `+columns, id, u.Status, u.Progress, u.ProgressLabel, u.Body, u.Data, u.Finished)
	out, err := scanNotification(row)
	if err != nil {
		return Notification{}, fmt.Errorf("notify: update activity: %w", err)
	}
	return out, nil
}

// closureCTE resolves every (user, role) pair of a tenant through user_roles
// plus role_belongs, transitively — the same closure UserRepository.FindGroups
// walks for one user. UNION (not ALL) makes cycles terminate.
const closureCTE = `
	WITH RECURSIVE closure(user_id, role_id) AS (
		SELECT ur.user_id, ur.role_id
		FROM user_roles ur JOIN users u ON u.id = ur.user_id
		WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND ur.deleted_at IS NULL
		UNION
		SELECT c.user_id, rb.belongs_to_role_id
		FROM closure c JOIN role_belongs rb ON rb.role_id = c.role_id AND rb.deleted_at IS NULL
	)`

// CallerCategories returns the categories a user's roles allow — read live
// from the database, so a role change applies on the next request.
func (r *Repository) CallerCategories(ctx context.Context, tenant, user uuid.UUID) ([]string, error) {
	rows, err := r.db.Query(ctx, closureCTE+`
		SELECT DISTINCT nc.key
		FROM closure c
		JOIN roles ro ON ro.id = c.role_id AND ro.deleted_at IS NULL
		JOIN role_notification_category rnc ON rnc.role_id = c.role_id AND rnc.deleted_at IS NULL
		JOIN notification_category nc ON nc.id = rnc.notification_category_id AND nc.deleted_at IS NULL
		WHERE c.user_id = $2`, tenant, user)
	if err != nil {
		return nil, fmt.Errorf("notify: caller categories: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// Audience returns every user of the tenant allowed the category — who a
// global notification of that category is sent to.
func (r *Repository) Audience(ctx context.Context, tenant uuid.UUID, category string) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, closureCTE+`
		SELECT DISTINCT c.user_id
		FROM closure c
		JOIN roles ro ON ro.id = c.role_id AND ro.deleted_at IS NULL
		JOIN role_notification_category rnc ON rnc.role_id = c.role_id AND rnc.deleted_at IS NULL
		JOIN notification_category nc ON nc.id = rnc.notification_category_id AND nc.deleted_at IS NULL
		WHERE nc.key = $2`, tenant, category)
	if err != nil {
		return nil, fmt.Errorf("notify: audience: %w", err)
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// visible is THE privacy filter: $1 tenant, $2 caller, $3 caller's categories.
const visible = `n.tenant_id = $1 AND n.deleted_at IS NULL
	AND (n.user_id = $2 OR (n.user_id IS NULL AND n.category = ANY($3)))`

// FeedItem is one feed row with the caller's read state. Notification is
// excluded from JSON; handlers serialize WireItem.
type FeedItem struct {
	Notification `json:"-"`
	Read         bool `json:"read"`
}

// WireItem is a feed row as the browser receives it.
type WireItem struct {
	Wire
	Read bool `json:"read"`
}

// feedLimit caps one feed read; retention keeps the table small anyway.
const feedLimit = 100

// Feed returns what the caller may see — running activities first, then the
// rest newest first — and how many of those are unread.
func (r *Repository) Feed(ctx context.Context, tenant, user uuid.UUID) ([]FeedItem, int, error) {
	cats, err := r.CallerCategories(ctx, tenant, user)
	if err != nil {
		return nil, 0, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT `+nColumns+`, (nr.id IS NOT NULL) AS read
		FROM notification n
		LEFT JOIN notification_read nr ON nr.notification_id = n.id AND nr.user_id = $2
		WHERE `+visible+`
		ORDER BY (n.status = 'running') DESC NULLS LAST, n.created_at DESC
		LIMIT `+fmt.Sprint(feedLimit), tenant, user, cats)
	if err != nil {
		return nil, 0, fmt.Errorf("notify: feed: %w", err)
	}
	defer rows.Close()
	var items []FeedItem
	unread := 0
	for rows.Next() {
		var it FeedItem
		n := &it.Notification
		if err := rows.Scan(&n.ID, &n.TenantID, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt, &n.UserID, &n.Category, &n.Kind,
			&n.Title, &n.Body, &n.Link, &n.Status, &n.Progress, &n.ProgressLabel, &n.ActorID, &n.FinishedAt, &n.Data, &it.Read); err != nil {
			return nil, 0, err
		}
		if !it.Read {
			unread++
		}
		items = append(items, it)
	}
	return items, unread, rows.Err()
}

// MarkRead marks the given notifications (or every visible one, with all)
// read for the caller, and returns the ids it actually marked: ids the caller
// can't see are ignored, never reported (no existence oracle).
func (r *Repository) MarkRead(ctx context.Context, tenant, user uuid.UUID, ids []uuid.UUID, all bool) ([]uuid.UUID, error) {
	cats, err := r.CallerCategories(ctx, tenant, user)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `
		INSERT INTO notification_read (tenant_id, user_id, notification_id, read_at)
		SELECT $1, $2, n.id, now() FROM notification n
		WHERE `+visible+` AND ($4 OR n.id = ANY($5))
		ON CONFLICT (user_id, notification_id) DO NOTHING
		RETURNING notification_id`, tenant, user, cats, all, ids)
	if err != nil {
		return nil, fmt.Errorf("notify: mark read: %w", err)
	}
	defer rows.Close()
	var marked []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		marked = append(marked, id)
	}
	return marked, rows.Err()
}

// Retention windows (spec: 7 days for finished global activities, 30 for personal).
const (
	globalRetention   = 7 * 24 * time.Hour
	personalRetention = 30 * 24 * time.Hour
)

// Sweep hard-deletes expired notifications and their read marks.
func (r *Repository) Sweep(ctx context.Context, now time.Time) (int64, error) {
	tag, err := r.db.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM notification
			WHERE (user_id IS NULL AND status IS DISTINCT FROM 'running' AND created_at < $1)
			   OR (user_id IS NOT NULL AND created_at < $2)
		), reads AS (
			DELETE FROM notification_read WHERE notification_id IN (SELECT id FROM expired)
		)
		DELETE FROM notification WHERE id IN (SELECT id FROM expired)`,
		now.Add(-globalRetention), now.Add(-personalRetention))
	if err != nil {
		return 0, fmt.Errorf("notify: sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}

// FailInterrupted marks every running activity failed — at boot, the process
// that ran them is gone (and their transactions were rolled back).
func (r *Repository) FailInterrupted(ctx context.Context) (int64, error) {
	tag, err := r.db.Exec(ctx, `
		UPDATE notification SET status = 'failed', body = 'Interrupted by a restart', finished_at = now(), updated_at = now()
		WHERE status = 'running'`)
	if err != nil {
		return 0, fmt.Errorf("notify: fail interrupted: %w", err)
	}
	return tag.RowsAffected(), nil
}

// RunningActivity returns the newest running global activity of category in
// tenant, or nil.
func (r *Repository) RunningActivity(ctx context.Context, tenant uuid.UUID, category string) (*Notification, error) {
	rows, err := r.db.Query(ctx, `SELECT `+columns+` FROM notification
		WHERE tenant_id = $1 AND category = $2 AND user_id IS NULL AND status = 'running' AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 1`, tenant, category)
	if err != nil {
		return nil, fmt.Errorf("notify: running activity: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	n, err := scanNotification(rows)
	if err != nil {
		return nil, err
	}
	return &n, nil
}
```

Note `ANY($3)` with a nil `[]string` matches nothing (pgx sends NULL → `= ANY(NULL)` is NULL) — the desired "no categories" behavior. Keep `columns`, `nColumns` and every Scan in the same order.

- [ ] **Step 4: Run the tests — expect PASS**

Run: `cd core && go test ./internal/notify/ -timeout 5m`

- [ ] **Step 5: Commit**

```bash
git add core/internal/notify
git commit -m "feat(notify): privacy-filtered feed, mark read, audience and retention"
```

---

### Task 3: Service — Personal / Start / Progress / Finish + targeted live delivery

**Files:**
- Create: `core/internal/notify/service.go`, `core/internal/notify/service_test.go`, `core/internal/notify/sweeper.go`
- Modify: `core/internal/presence/hub.go` (+ `SendToUsers`), `core/internal/presence/hub_test.go` (create if absent)

**Interfaces:**
- Consumes: Task 2 `Repository`.
- Produces:
  - `presence.(*Hub).SendToUsers(tenantID uuid.UUID, userIDs []uuid.UUID, payload []byte)`
  - `notify.Publisher` interface `{ SendToUsers(tenantID uuid.UUID, userIDs []uuid.UUID, payload []byte) }`
  - `notify.NewService(repo *Repository, pub Publisher) *Service`
  - `(*Service).Personal(ctx, tenant, user uuid.UUID, m Message) (Notification, error)`; `type Message struct { Category, Title, Body, Link string; Data *string }`
  - `(*Service).Start(ctx, tenant uuid.UUID, a Activity) (*Run, error)`; `type Activity struct { Category, Title, Link string; ActorID *uuid.UUID; Indeterminate bool }`
  - `(*Run).ID() uuid.UUID`, `(*Run).Progress(pct int, label string)`, `(*Run).Finish(err error, body string, data *string)`
  - `(*Service).FailInterrupted(ctx) error`; `notify.RunSweeper(ctx, repo *Repository)`
  - `(*Service).Repo() *Repository`
  - `notify.Wire` (the JSON shape of one notification: `id, category, kind, title, body, link, status, progress, progress_label, finished_at, created_at, data` — `user_id`/`actor_id`/`tenant_id` are never serialized) and `toWire(Notification) Wire`
  - Wire frame: `{"type":"notification","notification":Wire}`

- [ ] **Step 1: Write the failing hub test**

`core/internal/presence/hub_test.go`:
```go
package presence

import (
	"testing"

	"github.com/google/uuid"
)

func TestHub_SendToUsers_OnlyTargets(t *testing.T) {
	h := NewHub()
	tenant, other := uuid.New(), uuid.New()
	alice, bob, carol := uuid.New(), uuid.New(), uuid.New()
	mk := func(tn, u uuid.UUID) *client {
		c := &client{tenantID: tn, userID: u, send: make(chan []byte, 4)}
		h.register(c)
		return c
	}
	aliceTab1, aliceTab2, bobTab := mk(tenant, alice), mk(tenant, alice), mk(tenant, bob)
	carolElsewhere := mk(other, carol)

	h.SendToUsers(tenant, []uuid.UUID{alice, carol}, []byte("x"))

	tests := []struct {
		name string
		c    *client
		want int
	}{
		{"alice tab 1", aliceTab1, 1},
		{"alice tab 2", aliceTab2, 1},
		{"bob not targeted", bobTab, 0},
		{"carol targeted but in another tenant", carolElsewhere, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := len(tc.c.send); got != tc.want {
				t.Errorf("frames = %d, want %d", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run it — expect a compile failure**

Run: `cd core && go test ./internal/presence/ -run SendToUsers -timeout 2m`

- [ ] **Step 3: Implement `SendToUsers`**

Append to `core/internal/presence/hub.go`:
```go
// SendToUsers delivers payload to every open connection of the given users in
// tenantID — the targeted path notifications use (a personal one to its owner,
// a global one to its audience). Visibility is decided by the caller
// (internal/notify); the hub only routes, and never crosses tenants.
func (h *Hub) SendToUsers(tenantID uuid.UUID, userIDs []uuid.UUID, payload []byte) {
	h.mu.Lock()
	var targets []*client
	for _, u := range userIDs {
		for c := range h.byUser[u] {
			if c.tenantID == tenantID {
				targets = append(targets, c)
			}
		}
	}
	h.mu.Unlock()
	for _, c := range targets {
		select {
		case c.send <- payload:
		default:
		}
	}
}
```

- [ ] **Step 4: Run the hub test — expect PASS**

- [ ] **Step 5: Write the failing service tests**

`core/internal/notify/service_test.go`:
```go
package notify_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"core/internal/notify"

	"github.com/google/uuid"
)

type sent struct {
	tenant uuid.UUID
	users  []uuid.UUID
	frame  map[string]any
}

type fakePub struct {
	mu   sync.Mutex
	sent []sent
}

func (p *fakePub) SendToUsers(tenant uuid.UUID, users []uuid.UUID, payload []byte) {
	var frame map[string]any
	_ = json.Unmarshal(payload, &frame)
	p.mu.Lock()
	p.sent = append(p.sent, sent{tenant, users, frame})
	p.mu.Unlock()
}

func (p *fakePub) all() []sent {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]sent(nil), p.sent...)
}

func TestValidLink(t *testing.T) {
	tests := []struct {
		link string
		ok   bool
	}{
		{"/settings/developer", true},
		{"/cron/123", true},
		{"", false},
		{"//evil.example", false},
		{"https://evil.example", false},
		{"javascript:alert(1)", false},
		{"/\\evil.example", false},
	}
	for _, tc := range tests {
		t.Run(tc.link, func(t *testing.T) {
			if got := notify.ValidLink(tc.link); got != tc.ok {
				t.Errorf("ValidLink(%q) = %v, want %v", tc.link, got, tc.ok)
			}
		})
	}
}

func TestService_PersonalGoesToOwnerOnly(t *testing.T) {
	f := setup(t)
	pub := &fakePub{}
	svc := notify.NewService(f.repo, pub)
	n, err := svc.Personal(context.Background(), f.tenant, f.bob, notify.Message{Category: "dev_seed", Title: "Done", Link: "/settings/developer"})
	if err != nil {
		t.Fatal(err)
	}
	got := pub.all()
	if len(got) != 1 || len(got[0].users) != 1 || got[0].users[0] != f.bob || got[0].tenant != f.tenant {
		t.Fatalf("sent = %+v, want one frame to bob", got)
	}
	if got[0].frame["type"] != "notification" {
		t.Errorf("frame type = %v", got[0].frame["type"])
	}
	if inner, _ := got[0].frame["notification"].(map[string]any); inner["id"] != n.ID.String() {
		t.Errorf("frame notification = %v", got[0].frame["notification"])
	}
}

func TestService_RejectsBadInput(t *testing.T) {
	f := setup(t)
	svc := notify.NewService(f.repo, &fakePub{})
	ctx := context.Background()
	if _, err := svc.Personal(ctx, f.tenant, f.bob, notify.Message{Category: "nope", Title: "x", Link: "/x"}); err == nil {
		t.Error("an unregistered category must be refused")
	}
	if _, err := svc.Start(ctx, f.tenant, notify.Activity{Category: "cron", Title: "x", Link: "//evil"}); err == nil {
		t.Error("an external link must be refused")
	}
}

func TestService_ActivityLifecycle(t *testing.T) {
	f := setup(t)
	pub := &fakePub{}
	svc := notify.NewService(f.repo, pub)
	ctx := context.Background()

	run, err := svc.Start(ctx, f.tenant, notify.Activity{Category: "cron", Title: "Nightly", Link: "/cron/1"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ { // a tight loop must be throttled
		run.Progress(i, "step")
	}
	run.Finish(errors.New("boom"), "", nil)

	frames := pub.all()
	if len(frames) < 2 || len(frames) > 4 {
		t.Fatalf("frames = %d, want start + throttled progress + finish", len(frames))
	}
	for _, s := range frames {
		if len(s.users) != 1 || s.users[0] != f.alice {
			t.Errorf("cron activity sent to %v, want [alice] (bob has no cron category)", s.users)
		}
	}
	last, _ := frames[len(frames)-1].frame["notification"].(map[string]any)
	if last["status"] != "failed" || last["body"] != "boom" {
		t.Errorf("final frame = %v, want failed/boom", last)
	}
	time.Sleep(10 * time.Millisecond)
}
```

- [ ] **Step 6: Run them — expect compile failures**

Run: `cd core && go test ./internal/notify/ -timeout 5m`

- [ ] **Step 7: Implement the service and sweeper**

`core/internal/notify/service.go`:
```go
package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"core/internal/common"
	"core/orm/model"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// Publisher routes a live frame to the given users' open connections in one
// tenant (presence.Hub implements it).
type Publisher interface {
	SendToUsers(tenantID uuid.UUID, userIDs []uuid.UUID, payload []byte)
}

// progressInterval is the minimum gap between two live progress frames of one activity.
const progressInterval = 500 * time.Millisecond

// Service raises notifications: it validates, stores, then publishes each one
// to exactly the users allowed to see it.
type Service struct {
	repo *Repository
	pub  Publisher
}

// NewService wires the service. pub may be nil (no live delivery).
func NewService(repo *Repository, pub Publisher) *Service { return &Service{repo: repo, pub: pub} }

// Repo exposes the store (handlers, boot hooks).
func (s *Service) Repo() *Repository { return s.repo }

// ValidLink reports whether link is an ERP-relative path ("/x", never
// "//host", a scheme, or a backslash) — a notification can't open another site.
func ValidLink(link string) bool {
	return strings.HasPrefix(link, "/") && !strings.HasPrefix(link, "//") && !strings.ContainsAny(link, "\\:")
}

func validate(category, link string) error {
	if !IsCategory(category) {
		return fmt.Errorf("notify: unregistered category %q", category)
	}
	if !ValidLink(link) {
		return fmt.Errorf("notify: link %q is not an ERP path", link)
	}
	return nil
}

// Message is a one-off personal notification.
type Message struct {
	Category, Title, Body, Link string
	Data                        *string
}

// Personal stores a notification for user only and delivers it live to that
// user's connections.
func (s *Service) Personal(ctx context.Context, tenant, user uuid.UUID, m Message) (Notification, error) {
	if err := validate(m.Category, m.Link); err != nil {
		return Notification{}, err
	}
	n, err := s.repo.Create(ctx, Notification{
		BaseModel: model.BaseModel{TenantID: tenant}, UserID: &user,
		Category: m.Category, Kind: "message", Title: m.Title, Body: m.Body, Link: m.Link, Data: m.Data,
	})
	if err != nil {
		return Notification{}, err
	}
	s.send(n, []uuid.UUID{user})
	return n, nil
}

// Activity describes a global job.
type Activity struct {
	Category, Title, Link string
	ActorID               *uuid.UUID
	// Indeterminate: no percentage (a cron run) — progress stays NULL.
	Indeterminate bool
}

// Start stores a running global activity and announces it to its audience.
func (s *Service) Start(ctx context.Context, tenant uuid.UUID, a Activity) (*Run, error) {
	if err := validate(a.Category, a.Link); err != nil {
		return nil, err
	}
	running := "running"
	var progress *int
	if !a.Indeterminate {
		zero := 0
		progress = &zero
	}
	n, err := s.repo.Create(ctx, Notification{
		BaseModel: model.BaseModel{TenantID: tenant}, Category: a.Category, Kind: "activity",
		Title: a.Title, Link: a.Link, Status: &running, Progress: progress, ActorID: a.ActorID,
	})
	if err != nil {
		return nil, err
	}
	run := &Run{svc: s, n: n}
	s.publishGlobal(n)
	return run, nil
}

// Run is one started activity. Safe for use from one goroutine at a time.
type Run struct {
	svc       *Service
	mu        sync.Mutex
	n         Notification
	lastSent  time.Time
	lastLabel string
}

// ID is the activity's notification id.
func (r *Run) ID() uuid.UUID { return r.n.ID }

// Progress reports pct (0–100) and a step label. Throttled: at most one live
// frame per progressInterval, and a database write only when the label changes.
func (r *Run) Progress(pct int, label string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pct = max(0, min(100, pct))
	r.n.Progress, r.n.ProgressLabel = &pct, &label
	if label != r.lastLabel {
		r.lastLabel = label
		if n, err := r.svc.repo.UpdateActivity(context.Background(), r.n.ID, ActivityUpdate{Progress: &pct, ProgressLabel: &label}); err == nil {
			r.n = n
		} else {
			common.Logger.Warn("notify: progress write", zap.Error(err))
		}
	}
	if time.Since(r.lastSent) < progressInterval {
		return
	}
	r.lastSent = time.Now()
	r.svc.publishGlobal(r.n)
}

// Finish ends the activity: done, or failed with err's message. body
// overrides the stored body when non-empty; data is stored as is.
func (r *Run) Finish(err error, body string, data *string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	status := "done"
	if err != nil {
		status = "failed"
		if body == "" {
			body = err.Error()
		}
	}
	u := ActivityUpdate{Status: &status, Data: data, Finished: true}
	if body != "" {
		u.Body = &body
	}
	if status == "done" && r.n.Progress != nil {
		full := 100
		u.Progress = &full
	}
	n, werr := r.svc.repo.UpdateActivity(context.Background(), r.n.ID, u)
	if werr != nil {
		common.Logger.Error("notify: finish write", zap.Error(werr))
		return
	}
	r.n = n
	r.svc.publishGlobal(n)
}

// FailInterrupted marks activities left running by a previous process failed.
func (s *Service) FailInterrupted(ctx context.Context) error {
	_, err := s.repo.FailInterrupted(ctx)
	return err
}

func (s *Service) publishGlobal(n Notification) {
	if s.pub == nil {
		return
	}
	users, err := s.repo.Audience(context.Background(), n.TenantID, n.Category)
	if err != nil {
		common.Logger.Warn("notify: audience", zap.Error(err))
		return
	}
	s.send(n, users)
}

func (s *Service) send(n Notification, users []uuid.UUID) {
	if s.pub == nil || len(users) == 0 {
		return
	}
	payload, err := json.Marshal(struct {
		Type         string `json:"type"`
		Notification Wire   `json:"notification"`
	}{"notification", toWire(n)})
	if err != nil {
		common.Logger.Warn("notify: encode frame", zap.Error(err))
		return
	}
	s.pub.SendToUsers(n.TenantID, users, payload)
}

// Wire is the JSON shape of a notification, for live frames and the feed.
// model.BaseModel carries no json tags, and the owner/actor/tenant ids must
// never reach a browser, so it is spelled out here.
type Wire struct {
	ID            uuid.UUID  `json:"id"`
	Category      string     `json:"category"`
	Kind          string     `json:"kind"`
	Title         string     `json:"title"`
	Body          string     `json:"body"`
	Link          string     `json:"link"`
	Status        *string    `json:"status"`
	Progress      *int       `json:"progress"`
	ProgressLabel *string    `json:"progress_label"`
	FinishedAt    *time.Time `json:"finished_at"`
	CreatedAt     time.Time  `json:"created_at"`
	Data          *string    `json:"data"`
}

func toWire(n Notification) Wire {
	return Wire{ID: n.ID, Category: n.Category, Kind: n.Kind, Title: n.Title, Body: n.Body, Link: n.Link,
		Status: n.Status, Progress: n.Progress, ProgressLabel: n.ProgressLabel, FinishedAt: n.FinishedAt,
		CreatedAt: n.CreatedAt, Data: n.Data}
}
```

`core/internal/notify/sweeper.go`:
```go
package notify

import (
	"context"
	"time"

	"core/internal/common"

	"go.uber.org/zap"
)

// RunSweeper applies retention once at start, then hourly, until ctx ends.
func RunSweeper(ctx context.Context, repo *Repository) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if _, err := repo.Sweep(ctx, time.Now()); err != nil {
			common.Logger.Warn("notify: retention sweep", zap.Error(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
```

`model.BaseModel` has no json tags, which is why frames and the feed serialize `Wire`, never `Notification` directly.

- [ ] **Step 8: Run all notify + presence tests — expect PASS**

Run: `cd core && go test ./internal/notify/ ./internal/presence/ -timeout 5m`

- [ ] **Step 9: Commit**

```bash
git add core/internal/notify core/internal/presence
git commit -m "feat(notify): service with throttled progress, targeted live delivery"
```

---

### Task 4: HTTP handlers + app wiring

**Files:**
- Create: `core/internal/notify/handler.go`, `core/internal/notify/handler_test.go`
- Modify: `core/internal/app/app.go` (App field `notify *notify.Service`, routes, boot hooks, sweeper), `core/internal/app/app_test.go` (route table entries)

**Interfaces:**
- Consumes: `Service`, `Repository.Feed`, `Repository.MarkRead`, `presence.Hub.SendToUsers`.
- Produces:
  - `GET /api/v1/notifications` → `{"data": [WireItem…], "unread": n}` (no user/actor/tenant ids on the wire)
  - `POST /api/v1/notifications/read` body `{"ids": ["…"]}` or `{"all": true}` → `{"ids": [marked…]}`; publishes `{"type":"notification_read","ids":[…]}` (or `"all":true`) to the caller's own connections
  - `notify.NewHandler(svc *Service) *Handler` with methods `List`, `MarkRead`
  - `App.notify *notify.Service` (used by Tasks 5–6)

- [ ] **Step 1: Write the failing handler test** — two real users through the handler

`core/internal/notify/handler_test.go`:
```go
package notify_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/notify"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func call(t *testing.T, h echo.HandlerFunc, method, body string, id auth.Identity) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, "/api/v1/notifications", nil)
	} else {
		req = httptest.NewRequest(method, "/api/v1/notifications/read", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(auth.SetIdentity(req.Context(), id))
	rec := httptest.NewRecorder()
	if err := h(e.NewContext(req, rec)); err != nil {
		e.HTTPErrorHandler(e.NewContext(req, rec), err)
	}
	return rec
}

func TestHandler_TwoUsers(t *testing.T) {
	f := setup(t)
	pub := &fakePub{}
	svc := notify.NewService(f.repo, pub)
	h := notify.NewHandler(svc)
	ctx := context.Background()
	alicePersonal, _ := svc.Personal(ctx, f.tenant, f.alice, notify.Message{Category: "dev_seed", Title: "Mine", Link: "/settings/developer"})
	alice := auth.Identity{UserID: f.alice, TenantID: f.tenant}
	bob := auth.Identity{UserID: f.bob, TenantID: f.tenant}

	t.Run("bob's feed never contains alice's notification", func(t *testing.T) {
		rec := call(t, h.List, http.MethodGet, "", bob)
		if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), alicePersonal.ID.String()) {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	})
	t.Run("no user ids are ever serialized", func(t *testing.T) {
		body := call(t, h.List, http.MethodGet, "", alice).Body.String()
		if !strings.Contains(body, alicePersonal.ID.String()) || strings.Contains(body, f.alice.String()) || strings.Contains(body, "user_id") {
			t.Fatalf("feed = %s", body)
		}
	})
	t.Run("bob cannot mark it read, and learns nothing", func(t *testing.T) {
		rec := call(t, h.MarkRead, http.MethodPost, `{"ids":["`+alicePersonal.ID.String()+`"]}`, bob)
		var body struct{ IDs []uuid.UUID `json:"ids"` }
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusOK || len(body.IDs) != 0 {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	})
	t.Run("alice reads it; her other tabs are told", func(t *testing.T) {
		before := len(pub.all())
		rec := call(t, h.MarkRead, http.MethodPost, `{"all":true}`, alice)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		frames := pub.all()[before:]
		if len(frames) != 1 || frames[0].users[0] != f.alice || frames[0].frame["type"] != "notification_read" {
			t.Fatalf("frames = %+v", frames)
		}
		var feed struct{ Unread int `json:"unread"` }
		_ = json.Unmarshal(call(t, h.List, http.MethodGet, "", alice).Body.Bytes(), &feed)
		if feed.Unread != 0 {
			t.Errorf("unread = %d", feed.Unread)
		}
	})
	t.Run("malformed body is a 400", func(t *testing.T) {
		if rec := call(t, h.MarkRead, http.MethodPost, `{"ids":["not-a-uuid"]}`, alice); rec.Code != http.StatusBadRequest {
			t.Errorf("code = %d", rec.Code)
		}
	})
}
```

- [ ] **Step 2: Run it — expect a compile failure**

- [ ] **Step 3: Implement the handler**

`core/internal/notify/handler.go`:
```go
package notify

import (
	"encoding/json"
	"net/http"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler serves the caller's own feed. Both routes act only on the identity
// in the token — no route takes a user id — so they need the JWT middleware,
// not a permission: everyone reads their own notifications.
type Handler struct{ svc *Service }

// NewHandler wires the handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// List handles GET /api/v1/notifications.
func (h *Handler) List(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	items, unread, err := h.svc.repo.Feed(c.Request().Context(), id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	out := make([]WireItem, 0, len(items))
	for _, it := range items {
		out = append(out, WireItem{Wire: toWire(it.Notification), Read: it.Read})
	}
	return c.JSON(http.StatusOK, map[string]any{"data": out, "unread": unread})
}

type markReadRequest struct {
	IDs []uuid.UUID `json:"ids"`
	All bool        `json:"all"`
}

// MarkRead handles POST /api/v1/notifications/read. Ids the caller can't see
// are ignored; the caller's other tabs get a notification_read frame.
func (h *Handler) MarkRead(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	var req markReadRequest
	if err := json.NewDecoder(c.Request().Body).Decode(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": map[string]string{
			"code": "VALIDATION_ERROR", "message": "Malformed request body."}})
	}
	marked, err := h.svc.repo.MarkRead(c.Request().Context(), id.TenantID, id.UserID, req.IDs, req.All)
	if err != nil {
		return err
	}
	if marked == nil {
		marked = []uuid.UUID{}
	}
	if h.svc.pub != nil && (req.All || len(marked) > 0) {
		frame := map[string]any{"type": "notification_read", "ids": marked}
		if req.All {
			frame = map[string]any{"type": "notification_read", "all": true}
		}
		if payload, err := json.Marshal(frame); err == nil {
			h.svc.pub.SendToUsers(id.TenantID, []uuid.UUID{id.UserID}, payload)
		}
	}
	return c.JSON(http.StatusOK, map[string]any{"ids": marked})
}
```

- [ ] **Step 4: Run the handler test — expect PASS**

- [ ] **Step 5: Wire it in `internal/app/app.go`**

1. Add `notify *notify.Service` to the `App` struct (next to `presenceHub`), import `"core/internal/notify"`.
2. After `presenceHub := presence.NewHub()` (the Presence section), add:
```go
	// ── Notifications ─────────────────────────────────────────────────────────
	// Global activities + personal notifications (docs/adr/ADR-031-notifications.md),
	// delivered live over the presence socket to exactly the users allowed to
	// see each one (notify computes the audience; the hub only routes). JWT
	// only: both routes act on the caller's own feed.
	notifySvc := notify.NewService(notify.NewRepository(app.DB), presenceHub)
	a.notify = notifySvc
	if err := notifySvc.FailInterrupted(ctx); err != nil {
		common.Logger.Warn("notify: fail interrupted activities", zap.Error(err))
	}
	notifyHandler := notify.NewHandler(notifySvc)
	srv.Echo().GET("/api/v1/notifications", notifyHandler.List, jwtMw)
	srv.Echo().POST("/api/v1/notifications/read", notifyHandler.MarkRead, jwtMw)
```
(`a` is the `*App` being built in `Build`; if the presence section runs before `a` exists, store `notifySvc` in a local and assign `a.notify` where the other fields are set — follow how `presenceHub` reaches `App`.)
3. In `App.Run`, next to the presence sweeper: `go notify.RunSweeper(ctx, a.notify.Repo())`.
4. In `internal/app/app_test.go`'s route table add `{http.MethodGet, "/api/v1/notifications", nil, http.StatusOK}`.

- [ ] **Step 6: Run app + notify tests — expect PASS**

Run: `cd core && go test ./internal/app/ ./internal/notify/ -timeout 10m`

- [ ] **Step 7: Commit**

```bash
git add core/internal/notify core/internal/app
git commit -m "feat(notify): feed and mark-read endpoints, wired at boot"
```

---

### Task 5: Full seed as a background job with progress

**Files:**
- Modify: `core/internal/devseed/seed.go` (progress callback), `core/internal/devseed/handler.go` (202, guard, GET running id)
- Create: `core/internal/devseed/job.go`, `core/internal/devseed/job_test.go`
- Modify: `core/internal/app/app.go` (pass `notifySvc` to `devseed.NewHandler`)

**Interfaces:**
- Consumes: `notify.Service.Start`, `Run.Progress/Finish`, `Service.Personal`, `Repository.RunningActivity`.
- Produces:
  - `devseed.Progress func(pct int, label string)`
  - `devseed.SeedWithProgress(ctx, db, store, tenant, n, groups, progress Progress) ([]Result, error)`; `Seed` keeps its signature (calls it with nil)
  - `devseed.Validate(ctx, db, tenant, groups) error` — `ErrAlreadySeeded` / `ErrUnknownGroup` / nil
  - `devseed.Notifier` interface (call site) `{ Start(...) (*notify.Run, error); Personal(...) (notify.Notification, error); Repo() *notify.Repository }`
  - `devseed.NewHandler(db, store, environment string, notifier Notifier) *Handler`
  - `POST /api/v1/dev_seed` → `202 {"notification_id": "…"}`; 409 while running; `GET /api/v1/dev_seed` → `{"data": [...], "running": "<id>"|null}`

- [ ] **Step 1: Write the failing job test**

`core/internal/devseed/job_test.go` (package `devseed_test`, next to `seed_test.go`, whose `seededTables` slice it reuses):
```go
package devseed_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/devseed"
	"core/internal/notify"
	"core/internal/testdb"
	_ "core/modules/notify"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func TestHandler_SeedRunsInBackground(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "graphfield", "contact", "crm", "warehouse",
		"sale", "propertymanagement", "event", "notify")
	ctx := context.Background()
	tenant, user := uuid.New(), uuid.New()
	t.Cleanup(func() {
		for _, table := range append(seededTables, "notification") {
			_, _ = app.DB.Exec(ctx, "DELETE FROM "+table+" WHERE tenant_id = $1", tenant)
		}
	})
	if _, err := app.DB.Exec(ctx, "INSERT INTO company (tenant_id, name, currency, is_default) VALUES ($1, 'Home', 'EUR', true)", tenant); err != nil {
		t.Fatal(err)
	}
	svc := notify.NewService(notify.NewRepository(app.DB), nil)
	h := devseed.NewHandlerN(app.DB, nil, "development", svc, 20) // 20 rows per table: fast

	post := func(body string) *httptest.ResponseRecorder {
		e := echo.New()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/dev_seed", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: user, TenantID: tenant}))
		rec := httptest.NewRecorder()
		if err := h.Seed(e.NewContext(req, rec)); err != nil {
			e.HTTPErrorHandler(e.NewContext(req, rec), err)
		}
		return rec
	}

	if rec := post(`{"groups":["nope"]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown group: code = %d, want 400 before anything starts", rec.Code)
	}
	rec := post(`{"groups":["contacts"]}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d %s", rec.Code, rec.Body)
	}
	var body struct {
		NotificationID uuid.UUID `json:"notification_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)

	if rec := post(`{"groups":["crm"]}`); rec.Code != http.StatusConflict {
		t.Errorf("second seed while running: code = %d, want 409", rec.Code)
	}

	var status string
	for deadline := time.Now().Add(2 * time.Minute); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		_ = app.DB.QueryRow(ctx, `SELECT status FROM notification WHERE id = $1`, body.NotificationID).Scan(&status)
		if status != "running" {
			break
		}
	}
	if status != "done" {
		t.Fatalf("status = %q, want done", status)
	}
	var data string
	_ = app.DB.QueryRow(ctx, `SELECT data FROM notification WHERE id = $1`, body.NotificationID).Scan(&data)
	if !strings.Contains(data, `"entity":"contact"`) {
		t.Errorf("results data = %s", data)
	}
	var personal int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM notification WHERE user_id = $1 AND link = '/settings/developer'`, user).Scan(&personal)
	if personal != 1 {
		t.Errorf("initiator personal notifications = %d, want 1", personal)
	}
}

func TestRunJob_FailureFinishesFailed(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "notify")
	tenant, user := uuid.New(), uuid.New()
	t.Cleanup(func() { _, _ = app.DB.Exec(context.Background(), `DELETE FROM notification WHERE tenant_id = $1`, tenant) })
	svc := notify.NewService(notify.NewRepository(app.DB), nil)

	tests := []struct {
		name string
		seed devseed.SeedFunc
		body string
	}{
		{"error", func(_ context.Context, p devseed.Progress) ([]devseed.Result, error) {
			p(50, "halfway")
			return nil, errors.New("boom")
		}, "boom"},
		{"panic", func(context.Context, devseed.Progress) ([]devseed.Result, error) {
			panic("kaboom")
		}, "seed panicked: kaboom"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			id, err := devseed.RunJob(context.Background(), svc, tenant, user, tc.seed, true)
			if err != nil {
				t.Fatal(err)
			}
			var status, body string
			_ = app.DB.QueryRow(context.Background(), `SELECT status, body FROM notification WHERE id = $1`, id).Scan(&status, &body)
			if status != "failed" || body != tc.body {
				t.Errorf("status/body = %q/%q", status, body)
			}
		})
	}
	var titles int
	_ = app.DB.QueryRow(context.Background(), `SELECT count(*) FROM notification WHERE user_id = $1 AND title = 'Demo data seeding failed'`, user).Scan(&titles)
	if titles != 2 {
		t.Errorf("personal failure notifications = %d, want 2", titles)
	}
}
```

- [ ] **Step 2: Run them — expect compile failures**

- [ ] **Step 3: Implement**

In `seed.go`: rename the body of `Seed` to `SeedWithProgress(ctx, db, store, tenantID, n, groups, progress Progress)`; `Seed` becomes `return SeedWithProgress(ctx, db, store, tenantID, n, groups, nil)`. Inside, compute the work list before looping: `total := 0` steps that will run (count the same `seed`/`prepare` filter) `+ 2` (pictures, graphs); after each executed step `done++` and, if `progress != nil`, `progress(done*100/total, fmt.Sprintf("Seeding %s (%d/%d)", g.Label, groupIndex, groupCount))` where `groupIndex`/`groupCount` count the groups in `seed`. Before pictures: `progress(…, "Adding pictures")`; before graphs: `progress(…, "Building graph views")`. Add:
```go
// Progress receives the seed's completion (0–100) and current step label.
type Progress func(pct int, label string)

// Validate runs the checks Seed would fail on before writing anything:
// ErrUnknownGroup, or ErrAlreadySeeded when nothing selected is left to seed.
func Validate(ctx context.Context, db *orm.DB, tenantID uuid.UUID, groups []string) error {
	seeded, err := seededGroups(ctx, db, tenantID)
	if err != nil {
		return err
	}
	seed, _, err := plan(groups, seeded)
	if err != nil {
		return err
	}
	if len(seed) == 0 {
		return ErrAlreadySeeded
	}
	return nil
}
```

`core/internal/devseed/job.go`:
```go
package devseed

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"core/internal/notify"

	"github.com/google/uuid"
)

// Notifier is what a seed job needs from internal/notify.
type Notifier interface {
	Start(ctx context.Context, tenant uuid.UUID, a notify.Activity) (*notify.Run, error)
	Personal(ctx context.Context, tenant, user uuid.UUID, m notify.Message) (notify.Notification, error)
	Repo() *notify.Repository
}

// SeedFunc runs one seed, reporting progress.
type SeedFunc func(ctx context.Context, progress Progress) ([]Result, error)

const developerPage = "/settings/developer"

// RunJob starts a dev_seed activity and runs seed in the background (or
// inline with wait, for tests), finishing the activity and notifying the
// initiator whatever happens — the deferred Finish means a panic or error
// can never leave the activity "running".
func RunJob(ctx context.Context, n Notifier, tenant, user uuid.UUID, seed SeedFunc, wait bool) (uuid.UUID, error) {
	run, err := n.Start(ctx, tenant, notify.Activity{
		Category: "dev_seed", Title: "Seeding demo data", Link: developerPage, ActorID: &user,
	})
	if err != nil {
		return uuid.Nil, err
	}
	job := func() {
		start := time.Now()
		var results []Result
		var seedErr error
		defer func() {
			if r := recover(); r != nil {
				seedErr = fmt.Errorf("seed panicked: %v", r)
			}
			finish(n, run, tenant, user, results, seedErr, time.Since(start))
		}()
		results, seedErr = seed(context.Background(), run.Progress)
	}
	if wait {
		job()
	} else {
		go job()
	}
	return run.ID(), nil
}

func finish(n Notifier, run *notify.Run, tenant, user uuid.UUID, results []Result, seedErr error, took time.Duration) {
	var data *string
	if seedErr == nil {
		if b, err := json.Marshal(results); err == nil {
			s := string(b)
			data = &s
		}
	}
	run.Finish(seedErr, "", data)
	msg := notify.Message{Category: "dev_seed", Link: developerPage, Data: data}
	if seedErr != nil {
		msg.Title, msg.Body = "Demo data seeding failed", seedErr.Error()
	} else {
		msg.Title = fmt.Sprintf("Demo data seeded in %.0f s", took.Seconds())
	}
	_, _ = n.Personal(context.Background(), tenant, user, msg)
}
```

`handler.go`: add field `notifier Notifier`, `NewHandler(db, store, environment, notifier)` and a test helper constructor `NewHandlerN(db, store, environment, notifier, n int)`. Replace the body of `Seed` after decoding with:
```go
	id := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()
	switch err := Validate(ctx, h.db, id.TenantID, req.Groups); {
	case errors.Is(err, ErrAlreadySeeded):
		return errorJSON(c, http.StatusConflict, "CONFLICT", err.Error())
	case errors.Is(err, ErrUnknownGroup):
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	case err != nil:
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if running, err := h.notifier.Repo().RunningActivity(ctx, id.TenantID, "dev_seed"); err != nil {
		return err
	} else if running != nil {
		return errorJSON(c, http.StatusConflict, "CONFLICT", "A demo data seed is already running for this workspace.")
	}
	notificationID, err := RunJob(ctx, h.notifier, id.TenantID, id.UserID, func(jobCtx context.Context, p Progress) ([]Result, error) {
		return SeedWithProgress(jobCtx, h.db, h.store, id.TenantID, h.n, req.Groups, p)
	}, false)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusAccepted, map[string]any{"notification_id": notificationID})
```
(`h.mu sync.Mutex` serializes the check-then-start so two concurrent POSTs can't both pass the running check.) `Groups` adds `"running"`: the `RunningActivity` id or `nil`. Delete the now-unused `seedResponse`.

In `app.go`: `devseed.NewHandler(app.DB, seedPictures, a.cfg.Environment, notifySvc)` — the Notifications block must come before the Developer demo data block; move it up if needed.

- [ ] **Step 4: Run devseed + app tests — expect PASS**

Run: `cd core && go test ./internal/devseed/ ./internal/app/ -timeout 15m`
Existing `TestSeed*` keep calling `Seed` and must still pass. In `internal/app` tests that POST `/dev_seed` and expect `200`, update them to expect `202` and poll the notification as above.

- [ ] **Step 5: Commit**

```bash
git add core/internal/devseed core/internal/app
git commit -m "feat(devseed): run the full seed in the background with live progress"
```

---

### Task 6: Cron runs as activities

**Files:**
- Modify: `core/internal/cron/scheduler.go`, `core/internal/cron/scheduler_db_test.go`, `core/internal/app/app.go`

**Interfaces:**
- Consumes: `notify.Service` (`Start`, `Personal`).
- Produces: `cron.(*Scheduler).SetNotifier(n Notifier)`; `cron.Notifier` interface `{ Start(ctx, tenant uuid.UUID, a notify.Activity) (*notify.Run, error); Personal(ctx, tenant, user uuid.UUID, m notify.Message) (notify.Notification, error) }`.

- [ ] **Step 1: Write the failing test** — extend the existing `TestScheduler_Tick` in `scheduler_db_test.go`:
  1. Migrate notify too: `testdb.MigrateModules(t, app, "auth", "chatter", "notify")` and add the blank import `_ "core/modules/notify"`.
  2. Add `` `DELETE FROM notification WHERE tenant_id = $1`, `` first in the cleanup list.
  3. Replace `s.tick(ctx)` with:
```go
	s := NewScheduler(db, auth.NewUserRepository(db), auth.NewPermissionRepository(db), chatter.NewRepository(db), t.TempDir())
	s.SetNotifier(notify.NewService(notify.NewRepository(db), nil))
	s.tick(ctx)
```
  4. At the end of each subtest add:
```go
			var activities int
			var status string
			_ = db.QueryRow(ctx, `SELECT count(*), coalesce(max(status), '') FROM notification
				WHERE tenant_id = $1 AND category = 'cron' AND user_id IS NULL AND link = $2`,
				tenant, "/cron/"+ids[i].String()).Scan(&activities, &status)
			wantStatus := map[bool]string{true: "failed", false: "done"}[tt.wantFailed]
			if activities != tt.wantRuns || (tt.wantRuns == 1 && status != wantStatus) {
				t.Errorf("activities = %d (%s), want %d (%s)", activities, status, tt.wantRuns, wantStatus)
			}
			var personal int
			_ = db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE user_id IS NOT NULL AND link = $1`,
				"/cron/"+ids[i].String()).Scan(&personal)
			if wantPersonal := tt.wantRuns == 1 && tt.wantFailed; (personal == 1) != wantPersonal {
				t.Errorf("personal failure notifications = %d, want %v", personal, wantPersonal)
			}
```
(the first `s := …` line already exists — replace it, don't duplicate it).

- [ ] **Step 2: Run it — expect failure** (`SetNotifier` undefined)

- [ ] **Step 3: Implement** in `scheduler.go`:
```go
// Notifier is what the scheduler needs from internal/notify.
type Notifier interface {
	Start(ctx context.Context, tenant uuid.UUID, a notify.Activity) (*notify.Run, error)
	Personal(ctx context.Context, tenant, user uuid.UUID, m notify.Message) (notify.Notification, error)
}

// SetNotifier makes every run a "cron" activity (nil = none, the default).
func (s *Scheduler) SetNotifier(n Notifier) { s.notifier = n }
```
Add field `notifier Notifier`. In `runOne`, before `failed := s.attempt(...)`:
```go
	var run *notify.Run
	if s.notifier != nil {
		var err error
		run, err = s.notifier.Start(ctx, c.TenantID, notify.Activity{
			Category: "cron", Title: c.Name, Link: "/cron/" + c.ID.String(), Indeterminate: true,
		})
		if err != nil {
			common.Logger.Warn("cron: start activity", zap.Error(err))
		}
	}
```
and after `failed` is known:
```go
	if run != nil {
		var runErr error
		if failed {
			runErr = fmt.Errorf("the run failed — see its log")
		}
		run.Finish(runErr, "", nil)
		if failed && c.RunAsUserID != nil {
			_, _ = s.notifier.Personal(ctx, c.TenantID, *c.RunAsUserID, notify.Message{
				Category: "cron", Title: "Scheduled action failed: " + c.Name, Link: "/cron/" + c.ID.String(),
			})
		}
	}
```
In `app.go`'s `Run`: `cronScheduler.SetNotifier(a.notify)` right after `cron.NewScheduler(...)`.

- [ ] **Step 4: Run cron + app tests — expect PASS**

Run: `cd core && go test ./internal/cron/ ./internal/app/ -timeout 10m`

- [ ] **Step 5: Commit**

```bash
git add core/internal/cron core/internal/app
git commit -m "feat(cron): scheduled runs appear as live activities"
```

---

### Task 7: Frontend store, socket dispatch and Server Actions

**Files:**
- Create: `core-front/packages/core-front/src/views/notification-store.ts`, `…/notification-store.test.ts`
- Modify: `core-front/packages/core-front/src/views/presence-store.ts` (dispatch), `…/views/index.ts` (export)
- Create: `core-front/apps/shell/src/lib/notification-actions.ts`, `…/notification-actions.test.ts`
- Create: `core-front/apps/shell/src/components/NotificationsInit.tsx`, `…/NotificationsInit.test.tsx`; mount it in `apps/shell/app/app/layout.tsx` next to `PresenceInit`

**Interfaces:**
- Produces (engine, client barrel):
```ts
export interface AppNotification {
  id: string
  category: string
  kind: 'message' | 'activity'
  title: string
  body: string
  link: string
  status: 'running' | 'done' | 'failed' | null
  progress: number | null
  progress_label: string | null
  finished_at: string | null
  created_at: string
  data: string | null
  read: boolean
}
export interface NotificationState {
  items: AppNotification[]
  unread: number
  /** A live arrival the user hasn't looked at yet — drives the bell's breathing dot. */
  hasNew: boolean
  loaded: boolean
  setFeed(items: AppNotification[], unread: number): void
  upsert(n: Omit<AppNotification, 'read'>): void
  markRead(ids: string[] | 'all'): void
  acknowledge(): void // the panel was opened: hasNew = false
}
export const useNotificationStore: UseBoundStore<StoreApi<NotificationState>>
export function handleNotificationFrame(msg: { type?: string; notification?: unknown; ids?: string[]; all?: boolean }): boolean
export function onLiveReconnect(cb: () => void): () => void
```
- Produces (shell): `loadNotifications(): Promise<{ items: AppNotification[]; unread: number } | null>`, `markNotificationsRead(ids: string[] | 'all'): Promise<void>`, `revalidateSeededEntities(entities: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing store test**

`notification-store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { handleNotificationFrame, useNotificationStore, type AppNotification } from './notification-store'

const n = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n1', category: 'dev_seed', kind: 'activity', title: 'Seeding', body: '', link: '/settings/developer',
  status: 'running', progress: 0, progress_label: null, finished_at: null, created_at: '2026-10-13T10:00:00Z',
  data: null, read: false, ...over,
})

describe('useNotificationStore', () => {
  beforeEach(() => useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: false }))

  it('seeds from the feed without flagging anything new', () => {
    useNotificationStore.getState().setFeed([n()], 1)
    expect(useNotificationStore.getState()).toMatchObject({ unread: 1, hasNew: false, loaded: true })
  })

  it('a live arrival inserts, counts unread and flags new; an update of it does not double count', () => {
    const live: Omit<AppNotification, 'read'> = (({ read, ...rest }) => (void read, rest))(n())
    expect(handleNotificationFrame({ type: 'notification', notification: live })).toBe(true)
    expect(useNotificationStore.getState()).toMatchObject({ unread: 1, hasNew: true })
    handleNotificationFrame({ type: 'notification', notification: { ...live, progress: 50 } })
    const s = useNotificationStore.getState()
    expect(s.items).toHaveLength(1)
    expect(s.items[0]!.progress).toBe(50)
    expect(s.unread).toBe(1)
  })

  it('applies another tab\'s read marks', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' }), n({ id: 'b' })], 2)
    handleNotificationFrame({ type: 'notification_read', ids: ['a'] })
    expect(useNotificationStore.getState().unread).toBe(1)
    handleNotificationFrame({ type: 'notification_read', all: true })
    expect(useNotificationStore.getState().unread).toBe(0)
  })

  it('ignores presence frames and garbage', () => {
    expect(handleNotificationFrame({ type: 'update' })).toBe(false)
    expect(handleNotificationFrame({ type: 'notification', notification: { nope: 1 } })).toBe(true)
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it('acknowledge stops the new flag but keeps unread', () => {
    useNotificationStore.setState({ hasNew: true, unread: 3 })
    useNotificationStore.getState().acknowledge()
    expect(useNotificationStore.getState()).toMatchObject({ hasNew: false, unread: 3 })
  })
})
```

- [ ] **Step 2: Run it — expect failure** (`npx vitest run src/views/notification-store.test.ts` in `packages/core-front`)

- [ ] **Step 3: Implement the store**

`notification-store.ts`:
```ts
import { create } from 'zustand'

// The bell's state: the caller's notifications, seeded by one BFF read and kept
// live by the presence socket (presence-store.ts dispatches notification frames
// here). Not persisted — live server state, like presence. Go only ever sends
// a browser the notifications its user may see (internal/notify computes the
// audience), so nothing here filters for privacy.

export interface AppNotification {
  id: string
  category: string
  kind: 'message' | 'activity'
  title: string
  body: string
  link: string
  status: 'running' | 'done' | 'failed' | null
  progress: number | null
  progress_label: string | null
  finished_at: string | null
  created_at: string
  data: string | null
  read: boolean
}

export interface NotificationState {
  items: AppNotification[]
  unread: number
  hasNew: boolean
  loaded: boolean
  setFeed: (items: AppNotification[], unread: number) => void
  upsert: (n: Omit<AppNotification, 'read'>) => void
  markRead: (ids: string[] | 'all') => void
  acknowledge: () => void
}

const countUnread = (items: AppNotification[]) => items.filter((i) => !i.read).length

/** Running activities first, then newest first — the feed's own order. */
function sorted(items: AppNotification[]): AppNotification[] {
  return [...items].sort((a, b) => {
    const ra = a.status === 'running' ? 1 : 0
    const rb = b.status === 'running' ? 1 : 0
    return rb - ra || b.created_at.localeCompare(a.created_at)
  })
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  hasNew: false,
  loaded: false,
  setFeed: (items, unread) => set({ items: sorted(items), unread, loaded: true }),
  upsert: (n) => {
    const existing = get().items.find((i) => i.id === n.id)
    const items = existing
      ? get().items.map((i) => (i.id === n.id ? { ...n, read: i.read } : i))
      : [{ ...n, read: false }, ...get().items]
    set({ items: sorted(items), unread: countUnread(items), hasNew: get().hasNew || !existing })
  },
  markRead: (ids) => {
    const items = get().items.map((i) => (ids === 'all' || ids.includes(i.id) ? { ...i, read: true } : i))
    set({ items, unread: countUnread(items) })
  },
  acknowledge: () => set({ hasNew: false }),
}))

function isNotification(v: unknown): v is Omit<AppNotification, 'read'> {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o.id === 'string' && typeof o.title === 'string' && typeof o.link === 'string'
}

/** Applies one live frame; true when it was a notification frame (handled or not). */
export function handleNotificationFrame(msg: { type?: string; notification?: unknown; ids?: string[]; all?: boolean }): boolean {
  if (msg.type === 'notification') {
    if (isNotification(msg.notification)) useNotificationStore.getState().upsert(msg.notification)
    return true
  }
  if (msg.type === 'notification_read') {
    useNotificationStore.getState().markRead(msg.all ? 'all' : (msg.ids ?? []))
    return true
  }
  return false
}

const reconnectListeners = new Set<() => void>()

/** Called by the presence socket on every (re)connect: frames sent while the
 * socket was down are not replayed, so the feed is re-read. */
export function onLiveReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb)
  return () => reconnectListeners.delete(cb)
}

export function notifyLiveReconnect(): void {
  for (const cb of reconnectListeners) cb()
}
```

In `presence-store.ts` `ws.onmessage`, after parsing `m`, first line: `if (handleNotificationFrame(m)) return`; add `ws.onopen = () => notifyLiveReconnect()`; import both from `./notification-store`. Export `./notification-store` from `views/index.ts`.

- [ ] **Step 4: Run engine tests — expect PASS**, then rebuild the engine.

- [ ] **Step 5: Server Actions + init component** (with tests mocking `apiRequest`, mirroring `src/lib/website-settings.test.ts`)

`apps/shell/src/lib/notification-actions.ts`:
```ts
'use server'
import { revalidateTag } from 'next/cache'
import { apiRequest } from '@eerp/core-front/server'
import type { AppNotification } from '@eerp/core-front'

// The bell's BFF: the caller's own feed and read marks (Go scopes both to the
// session's user — internal/notify). Never cached: per-user data.

export async function loadNotifications(): Promise<{ items: AppNotification[]; unread: number } | null> {
  try {
    const res = await apiRequest<{ data?: AppNotification[]; unread?: number }>('GET', '/notifications')
    return { items: res.data ?? [], unread: res.unread ?? 0 }
  } catch {
    return null
  }
}

export async function markNotificationsRead(ids: string[] | 'all'): Promise<void> {
  try {
    await apiRequest('POST', '/notifications/read', ids === 'all' ? { all: true } : { ids })
  } catch {
    // Best effort: the badge reconciles on the next feed read.
  }
}

/** After a background full seed: drop the cached list pages of what Go wrote. */
export async function revalidateSeededEntities(entities: string[]): Promise<void> {
  for (const e of entities) if (/^[a-z0-9_]+$/.test(e)) revalidateTag(e, 'max')
}
```
Tests: `loadNotifications` maps the envelope and returns `null` on `ApiError`; `markNotificationsRead('all')` posts `{all: true}`; `revalidateSeededEntities(['contact', 'bad name'])` revalidates only `contact`.

`apps/shell/src/components/NotificationsInit.tsx`:
```tsx
'use client'
import { useEffect } from 'react'
import { onLiveReconnect, useNotificationStore, useSessionStore } from '@eerp/core-front'
import { loadNotifications } from '@/lib/notification-actions'

// Loads the caller's notifications once a session exists, and again whenever
// the live socket reconnects (frames missed while it was down aren't replayed).
export function NotificationsInit() {
  const hasIdentity = useSessionStore((s) => s.identity !== null)
  useEffect(() => {
    if (!hasIdentity) {
      useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: false })
      return
    }
    const load = () =>
      void loadNotifications().then((feed) => {
        if (feed) useNotificationStore.getState().setFeed(feed.items, feed.unread)
      })
    load()
    return onLiveReconnect(load)
  }, [hasIdentity])
  return null
}
```
Test: with an identity it calls `loadNotifications` and seeds the store; without, it clears it. Mount `<NotificationsInit />` in `apps/shell/app/app/layout.tsx` beside `<PresenceInit />`.

- [ ] **Step 6: Run shell tests for the new files — expect PASS**

- [ ] **Step 7: Commit**

```bash
git add core-front
git commit -m "feat(front): notification store fed by the BFF and the live socket"
```

---

### Task 8: The bell

**Files:**
- Create: `core-front/apps/shell/src/components/NotificationBell.tsx`, `…/NotificationBell.test.tsx`
- Modify: `core-front/apps/shell/src/components/AppTopBar.tsx` (render `<NotificationBell />` immediately before `{activeCompany && <CompanyLogo …/>}`), `core-front/apps/shell/src/components/ErpUiStyle.tsx` (keyframes), `core-front/apps/shell/i18n/shell.pot` + `fr.po` (msgids below)

**Interfaces:**
- Consumes: `useNotificationStore`, `markNotificationsRead`, `erpPath`, `useT`.
- Produces: `NotificationBell` (no props); CSS class `erp-breathe` on the dot.

Msgids (pot + fr): "Notifications" / "Notifications", "Running now" / "En cours", "Mark all as read" / "Tout marquer comme lu", "No notifications" / "Aucune notification", "Failed" / "Échec", "Scheduled actions" / "Actions planifiées", "Demo data seeding" / "Génération de données de démonstration", "Seeding demo data" / "Génération des données de démonstration", "Demo data seeding failed" / "Échec de la génération des données de démonstration", "New notifications" / "Nouvelles notifications".

- [ ] **Step 1: Write the failing test**

`NotificationBell.test.tsx`:
```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useNotificationStore, type AppNotification } from '@eerp/core-front'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const markNotificationsRead = vi.fn(async () => {})
vi.mock('@/lib/notification-actions', () => ({ markNotificationsRead: (...a: unknown[]) => markNotificationsRead(...(a as [])) }))

import { NotificationBell } from './NotificationBell'

const n = (over: Partial<AppNotification>): AppNotification => ({
  id: 'x', category: 'dev_seed', kind: 'message', title: 'T', body: '', link: '/settings/developer',
  status: null, progress: null, progress_label: null, finished_at: null, created_at: new Date().toISOString(),
  data: null, read: false, ...over,
})

describe('NotificationBell', () => {
  beforeEach(() => {
    push.mockReset()
    markNotificationsRead.mockClear()
    useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: true })
  })

  it('shows the unread count and breathes only for a new arrival, until opened', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' })], 1)
    render(<NotificationBell />)
    expect(screen.getByRole('button', { name: /notifications/i })).toHaveTextContent('1')
    expect(screen.queryByTestId('notification-dot')).toBeNull()

    useNotificationStore.getState().upsert({ ...n({ id: 'b', title: 'Seed done' }) })
    expect(screen.getByTestId('notification-dot')).toHaveClass('erp-breathe')

    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.queryByTestId('notification-dot')).toBeNull()
  })

  it('lists running activities with progress, then the rest', () => {
    useNotificationStore.getState().setFeed([
      n({ id: 'run', kind: 'activity', status: 'running', title: 'Seeding demo data', progress: 40, progress_label: 'Seeding invoices (5/8)' }),
      n({ id: 'done', title: 'Demo data seeded in 38 s' }),
    ], 2)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    expect(screen.getByText('Running now')).toBeInTheDocument()
    expect(screen.getByText('Seeding invoices (5/8)')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByText('Demo data seeded in 38 s')).toBeInTheDocument()
  })

  it('clicking an item marks it read and opens its ERP page', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a', title: 'Seed done', link: '/settings/developer' })], 1)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByText('Seed done'))
    expect(markNotificationsRead).toHaveBeenCalledWith(['a'])
    expect(push).toHaveBeenCalledWith('/app/settings/developer')
    expect(useNotificationStore.getState().unread).toBe(0)
  })

  it('never navigates to an external link', () => {
    useNotificationStore.getState().setFeed([n({ id: 'evil', title: 'Evil', link: '//evil.example' })], 1)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByText('Evil'))
    expect(push).not.toHaveBeenCalled()
  })

  it('mark all as read', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' }), n({ id: 'b' })], 2)
    render(<NotificationBell />)
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(markNotificationsRead).toHaveBeenCalledWith('all')
    expect(useNotificationStore.getState().unread).toBe(0)
  })
})
```

- [ ] **Step 2: Run it — expect failure**

- [ ] **Step 3: Implement**

`NotificationBell.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, erpPath, FontAwesomeIcon, useNotificationStore, useT, type AppNotification } from '@eerp/core-front'
import { markNotificationsRead } from '@/lib/notification-actions'

// The top bar's bell (left of the company logo): unread badge, a breathing red
// dot while a live arrival is unseen, and a panel — running activities with
// their progress, then personal and finished notifications. Clicking one marks
// it read and opens its ERP page.

/** An ERP path only — mirrors Go's notify.ValidLink, so a bad row can't redirect elsewhere. */
const isErpPath = (link: string) => link.startsWith('/') && !link.startsWith('//') && !/[\\:]/.test(link)

function relativeTime(iso: string, locale?: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour')
  return rtf.format(Math.round(seconds / 86400), 'day')
}

export function NotificationBell() {
  const t = useT()
  const router = useRouter()
  const { items, unread, hasNew, acknowledge, markRead } = useNotificationStore()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const running = items.filter((i) => i.status === 'running')
  const rest = items.filter((i) => i.status !== 'running')

  function open(e: React.MouseEvent<HTMLElement>) {
    setAnchor(e.currentTarget)
    acknowledge()
  }

  function go(n: AppNotification) {
    if (!n.read) {
      markRead([n.id])
      void markNotificationsRead([n.id])
    }
    if (!isErpPath(n.link)) return
    setAnchor(null)
    router.push(erpPath(n.link))
  }

  function readAll() {
    markRead('all')
    void markNotificationsRead('all')
  }

  return (
    <>
      <IconButton color="inherit" aria-label={t('Notifications')} onClick={open} sx={{ mr: 1, position: 'relative' }}>
        <Badge badgeContent={unread} max={9} color="error">
          <FontAwesomeIcon icon={byPrefixAndName.fas['bell']} />
        </Badge>
        {hasNew ? (
          <Box
            component="span"
            data-testid="notification-dot"
            className="erp-breathe"
            aria-label={t('New notifications')}
            sx={{ position: 'absolute', top: 6, left: 6, width: 8, height: 8, borderRadius: '50%', bgcolor: 'error.main' }}
          />
        ) : null}
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 360, maxWidth: 'calc(100vw - 32px)', maxHeight: 480 } } }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1 }}>
          <Typography variant="subtitle1">{t('Notifications')}</Typography>
          <Button size="small" onClick={readAll} disabled={unread === 0}>
            {t('Mark all as read')}
          </Button>
        </Stack>
        <Divider />
        {items.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            {t('No notifications')}
          </Typography>
        ) : null}
        {running.length ? (
          <>
            <Typography variant="overline" color="text.secondary" sx={{ px: 2 }}>
              {t('Running now')}
            </Typography>
            <List dense disablePadding>
              {running.map((n) => (
                <ListItemButton key={n.id} onClick={() => go(n)} sx={{ display: 'block' }}>
                  <Typography variant="body2">{t(n.title)}</Typography>
                  {n.progress_label ? (
                    <Typography variant="caption" color="text.secondary">
                      {n.progress_label}
                    </Typography>
                  ) : null}
                  <LinearProgress
                    sx={{ mt: 0.5 }}
                    {...(n.progress == null ? {} : { variant: 'determinate' as const, value: n.progress })}
                  />
                </ListItemButton>
              ))}
            </List>
            <Divider />
          </>
        ) : null}
        <List dense disablePadding>
          {rest.map((n) => (
            <ListItemButton
              key={n.id}
              onClick={() => go(n)}
              sx={{ display: 'block', bgcolor: n.read ? undefined : 'action.hover' }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                {n.status === 'failed' ? (
                  <Typography variant="caption" color="error.main" sx={{ fontWeight: 600 }}>
                    {t('Failed')}
                  </Typography>
                ) : null}
                <Typography variant="body2" sx={{ fontWeight: n.read ? 400 : 600, flex: 1 }}>
                  {t(n.title)}
                </Typography>
              </Stack>
              {n.body ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {n.body}
                </Typography>
              ) : null}
              <Typography variant="caption" color="text.secondary">
                {relativeTime(n.finished_at ?? n.created_at)}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </Popover>
    </>
  )
}
```
(The arrival of a personal message also counts toward `hasNew`, by `upsert`. `t(n.title)` translates registered titles such as "Seeding demo data"; dynamic ones like "Demo data seeded in 38 s" fall back to the source text.)

`ErpUiStyle.tsx` `pretty` — add:
```ts
  // The bell's "something new" dot (NotificationBell): a slow pulse until opened.
  '@keyframes erp-breathe': {
    '0%, 100%': { transform: 'scale(1)', opacity: 1 },
    '50%': { transform: 'scale(1.6)', opacity: 0.45 },
  },
  '.erp-breathe': { animation: `erp-breathe 1.8s ${ease} infinite` },
```
(The performance style's global `animationDuration: 0.01ms` already stops it; the theme's reduced-motion rule too.)

`AppTopBar.tsx`: import `NotificationBell` and render `<NotificationBell />` as the Toolbar's first child, before `{activeCompany && <CompanyLogo … />}`.

- [ ] **Step 4: Run the bell + top bar tests — expect PASS**

Run: `cd core-front/apps/shell && npx vitest run src/components/NotificationBell.test.tsx src/components/AppTopBar.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add core-front
git commit -m "feat(front): notification bell with breathing new-item dot"
```

---

### Task 9: Notifications tab on roles

**Files:**
- Modify: `core-front/apps/shell/app/app/settings/users/descriptors.ts`, `…/descriptors.test.ts`

**Interfaces:**
- Consumes: generic CRUD `notification_category` (catalog, `name` = label) and `role_notification_category` junction (Task 1).

- [ ] **Step 1: Write the failing test** — in `descriptors.test.ts`:
```ts
it('role form manages notification categories on its own Notifications tab', () => {
  const field = roleFormDescriptor.fields.find((f) => f.name === 'notifications')
  expect(field?.relation).toMatchObject({
    entity: 'notification_category',
    kind: 'many2many',
    via: 'role_notification_category',
    viaFields: { own: 'role_id', related: 'notification_category_id' },
    labelField: 'name',
  })
  const notebook = roleFormDescriptor.layout!.find((n) => n.kind === 'notebook') as { children: { title?: string; children: { name?: string }[] }[] }
  const page = notebook.children.find((p) => p.title === 'Notifications')
  expect(page?.children.map((c) => c.name)).toEqual(['notifications'])
})
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3: Implement** — add to `roleFormDescriptor.fields`:
```ts
    {
      // Which global activities (scheduled actions, demo-data seeding, …) members
      // of this role — and of every role belonging to it — see under the bell.
      // Personal notifications always reach their owner and aren't set here.
      // Generic-CRUD junction over the per-tenant category catalog Go syncs
      // from its registry (core/internal/notify), like `belongs` above.
      name: 'notifications',
      label: 'Notifications',
      type: 'relation',
      relation: {
        entity: 'notification_category',
        kind: 'many2many',
        via: 'role_notification_category',
        viaFields: { own: 'role_id', related: 'notification_category_id' },
        labelField: 'name',
      },
    },
```
and a page after "Belongs": `{ kind: 'page', title: 'Notifications', children: [{ kind: 'field', name: 'notifications' }] },`.

- [ ] **Step 4: Run the users descriptors tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add core-front/apps/shell/app/app/settings/users
git commit -m "feat(front): manage a role's notification categories"
```

---

### Task 10: Developer page progress loader

**Files:**
- Modify: `core-front/apps/shell/src/lib/dev-seed.ts` (+ test), `core-front/apps/shell/src/components/DeveloperSettings.tsx` (+ test)

**Interfaces:**
- Consumes: `useNotificationStore` (Task 7), `revalidateSeededEntities` (Task 7), Go's `202 {notification_id}` and `GET /dev_seed` `running` (Task 5).
- Produces: `seedDemoData('full', groups)` → `{ ok: true; started: string } | { ok: true; results } | { ok: false; message }`; `getSeedGroups()` → `{ groups: SeedGroup[]; running: string | null } | null`.

- [ ] **Step 1: Write the failing component test** (extend `DeveloperSettings.test.tsx`, which already mocks `@/lib/dev-seed`):
```tsx
it('follows a full seed through the live notification: progress, then results', async () => {
  getSeedGroups.mockResolvedValue({ groups: [{ key: 'contacts', label: 'Contacts', deps: [], seeded: false }], running: null })
  seedDemoData.mockResolvedValue({ ok: true, started: 'run-1' })
  render(<DeveloperSettings isDev />)
  fireEvent.click(await screen.findByLabelText(/full/i))
  fireEvent.click(screen.getByRole('button', { name: /seed/i }))

  act(() => useNotificationStore.getState().upsert({
    id: 'run-1', category: 'dev_seed', kind: 'activity', title: 'Seeding demo data', body: '', link: '/settings/developer',
    status: 'running', progress: 40, progress_label: 'Seeding contacts (1/1)', finished_at: null, created_at: new Date().toISOString(), data: null,
  }))
  expect(await screen.findByText('Seeding contacts (1/1)')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')

  act(() => useNotificationStore.getState().upsert({
    id: 'run-1', category: 'dev_seed', kind: 'activity', title: 'Seeding demo data', body: '', link: '/settings/developer',
    status: 'done', progress: 100, progress_label: null, finished_at: new Date().toISOString(), created_at: new Date().toISOString(),
    data: JSON.stringify([{ entity: 'contact', created: 20 }]),
  }))
  expect(await screen.findByText('contact')).toBeInTheDocument()
  expect(revalidateSeededEntities).toHaveBeenCalledWith(['contact'])
})

it('resumes tracking a seed already running after a reload', async () => {
  getSeedGroups.mockResolvedValue({ groups: [], running: 'run-9' })
  render(<DeveloperSettings isDev />)
  act(() => useNotificationStore.getState().upsert({
    id: 'run-9', category: 'dev_seed', kind: 'activity', title: 'Seeding demo data', body: '', link: '/settings/developer',
    status: 'running', progress: 10, progress_label: 'Seeding products (1/3)', finished_at: null, created_at: new Date().toISOString(), data: null,
  }))
  expect(await screen.findByText('Seeding products (1/3)')).toBeInTheDocument()
})

it('shows the failure message when the run fails', async () => {
  getSeedGroups.mockResolvedValue({ groups: [], running: 'run-2' })
  render(<DeveloperSettings isDev />)
  act(() => useNotificationStore.getState().upsert({
    id: 'run-2', category: 'dev_seed', kind: 'activity', title: 'Seeding demo data', body: 'boom', link: '/settings/developer',
    status: 'failed', progress: 30, progress_label: null, finished_at: new Date().toISOString(), created_at: new Date().toISOString(), data: null,
  }))
  expect(await screen.findByText('boom')).toBeInTheDocument()
})
```
Adjust the existing tests that relied on `getSeedGroups` returning an array and the full seed returning `results` synchronously.

- [ ] **Step 2: Run them — expect FAIL**

- [ ] **Step 3: Implement**

`dev-seed.ts`:
- `SeedResult` gains `| { ok: true; started: string }`.
- `getSeedGroups()` returns `{ groups: res.data ?? [], running: res.running ?? null }` from `apiRequest<{ data?: SeedGroup[]; running?: string | null }>('GET', '/dev_seed')`, `null` on error.
- `seedFullVolume(groups)`: `const res = await apiRequest<{ notification_id: string }>('POST', '/dev_seed', { groups }); return { ok: true, started: res.notification_id }` (errors unchanged). Remove the synchronous revalidation (moved to the page on completion).

`DeveloperSettings.tsx`:
- state `const [runId, setRunId] = useState<string | null>(null)`; on load, `setRunId(list.running)` (and `setGroups(list.groups)`).
- `onSeed`: on `outcome.ok && 'started' in outcome` → `setRunId(outcome.started)` and keep `seeding` true; otherwise the existing light-seed path.
- `const run = useNotificationStore((s) => (runId ? s.items.find((i) => i.id === runId) : undefined))`.
- effect on `run?.status`: when `'done'` → parse `run.data` (`JSON.parse` in try/catch → `{ entity: string; created: number }[]`), merge duplicates like before, `setResults(...)`, `void revalidateSeededEntities(entities)`, `setSeeding(false)`, `setRunId(null)`, `void loadGroups()`; when `'failed'` → `setError(run.body || t('The full demo seed failed.'))`, `setSeeding(false)`, `setRunId(null)`.
- while `runId` and `run?.status === 'running'` (or `run` not yet arrived), render under the button:
```tsx
<Stack spacing={0.5} data-testid="seed-progress">
  <Typography variant="body2" color="text.secondary">
    {run?.progress_label ?? t('Starting…')}
  </Typography>
  <LinearProgress {...(run?.progress == null ? {} : { variant: 'determinate' as const, value: run.progress })} />
</Stack>
```
- Add msgids "Starting…" / "Démarrage…" to the shell catalogs.

- [ ] **Step 4: Run Developer + dev-seed tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add core-front
git commit -m "feat(front): live progress loader for the full demo seed"
```

---

### Task 11: Docs, full verification

**Files:**
- Create: `docs/adr/ADR-031-notifications.md`
- Modify: `CLAUDE.md` (an `internal/notify/` bullet; the `internal/devseed/` bullet: 202 + background job; `internal/presence/` bullet: the channel also carries notification frames via `SendToUsers`), `core-front/CLAUDE.md` (a "Notifications" Conventions row: bell, store, frames, roles tab, developer progress)

- [ ] **Step 1: Write the ADR** — context (silent 40 s seed, no visibility of background jobs), decision (core `notify`, audience computed per publish, shared presence socket, catalog + junction for roles), consequences (single-process hub as ADR-019; progress throttling; retention), alternatives rejected (separate socket, polling, per-connection category caches), and the privacy invariant verbatim from the plan's Global Constraints. Include a mermaid sequence: producer → `notify.Service` → DB → `Audience` → `Hub.SendToUsers` → browser store → bell.

- [ ] **Step 2: CLAUDE.md entries** — `internal/notify/` bullet covering: tables, `RegisterCategory` / `Personal` / `Start`/`Progress`/`Finish`, routes, privacy invariant, retention, `FailInterrupted` at boot, adding a category (register + `.po` label; catalog syncs at boot, new categories go to the admin role once). Pitfalls: never send a notification frame through `Hub.Broadcast`; links must be ERP paths.

- [ ] **Step 3: Full verification**

```bash
make test        # Go (with Redis), pdf-service, frontend lint + typecheck + tests
cd core && LC_ALL=C.UTF-8 deadcode -f '{{range .Funcs}}{{$.Path}}.{{.Name}}{{"\n"}}{{end}}' ./... | sort > /tmp/dead.txt \
  && sed '/^#/d' ../.github/deadcode-allowlist.txt | sort | comm -23 /tmp/dead.txt -   # must print nothing
```
Then a live check on the dev stack (`docker compose build core-back core-front && docker compose up -d --wait core-back core-front`): sign in as admin, start a full seed from Settings → Developer, watch the progress bar and the bell's running item, see the dot breathe on completion, click the personal notification → lands on Settings → Developer. Sign in as a second user without the `dev_seed` category in another browser: no seed activity, no personal notification of the admin.

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md core-front/CLAUDE.md
git commit -m "docs: notifications ADR and CLAUDE.md entries"
```
