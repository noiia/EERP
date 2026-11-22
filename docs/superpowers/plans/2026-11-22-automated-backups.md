# Automated Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled, atomic, per-database backup bundles (`<db>.zip`, S3 included) written to a folder Backrest snapshots, managed from Settings → Developer.

**Architecture:** A new `core/internal/backup` package keeps everything as files in `backup_dir` (settings JSON, `history.jsonl`, published run folders). It reuses dbmanage's extract zip through a new `io.Writer` entry point, serializes runs with a Postgres advisory lock taken on the server's `postgres` database, and is driven by a one-minute ticker in `App.Run`.

**Tech Stack:** Go (echo v5, pgx v5, zap, stdlib `archive/zip`/`crypto/sha256`), Next.js server actions + MUI, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-automated-backups-design.md`

## Global Constraints

- One `<db_name>.zip` per database, in the exact format `dbmanage` extracts and restores (`dump.dump`, `manifest.json`, `s3/<key>`).
- Nothing under `YYYY/MM/<stamp>/` exists until the whole run is complete: build in `<backup_dir>/.tmp/<run id>/`, `os.Rename` last.
- Stamp format `2006-01-02T150405Z` (UTC); published path `YYYY/MM/<stamp>`.
- No new database, table or container. `backup_dir` unset → routes and ticker not mounted.
- `history.jsonl` keeps the newest 500 lines.
- Settings ranges: `every_hours` 1–168, `month_day` 1–28, `retention_days` ≥ 1 (default 14), `time` `HH:MM`, `timezone` IANA, `weekdays` 0–6 (0 = Sunday), `include_s3` default true.
- Permissions `backups:backups:read|write`, route-derived; never return DB credentials or S3 secrets.
- Logs via `common.Logger` (zap); `fmt`/`log` are blocked by depguard. Search with `rg`.

## Review Focus

- A selected database deleted since it was picked → run continues, warning recorded, not a failure (Task 4 test `TestRun_MissingDatabaseIsWarning`).
- Process killed mid-run → next boot removes `.tmp/*` only when the lock is free, published folders untouched (Task 4 `TestCleanupStale_SkipsWhenLocked`).
- `include_s3` true but no S3 configured → that run fails with a clear error, not a partial zip (Task 4 `TestRun_S3RequestedWithoutStore`).
- Retention with every bundle expired → newest kept (Task 3 `TestRetention_KeepsNewest`).
- Settings saved with a timezone typo or weekly with no weekdays → 400, file unchanged (Task 2 `TestValidate` rows).

---

### Task 1: dbmanage bundle writer + `backup_dir` config

**Files:**
- Modify: `core/internal/dbmanage/extract.go` (split), `core/internal/dbmanage/manager.go`
- Modify: `core/internal/types/config.go` (field + `ResolvePaths`), `core/internal/types/config_test.go`
- Modify: `.gitignore` (`/backups/`), `eerp-config.example.json`, `eerp-config.docker.example.json` (`"backup_dir": "backups"`), `eerp-config.prod.example.json` (`"backup_dir": "/app/backups"`)
- Test: `core/internal/dbmanage/files_test.go` (or a new `bundle_test.go`)

**Interfaces:**
- Produces:
  - `func (m *Manager) WriteBundle(ctx context.Context, w io.Writer, dbName string, includeS3 bool) (s3Objects int, err error)` — the zip body `Extract` used to write; `Extract` now sets headers and calls it. Returns `ErrNoObjectStore` (new exported sentinel) when `includeS3 && m.objects == nil`; `Extract` maps it to the existing 400.
  - `func (m *Manager) DatabaseNames(ctx context.Context) ([]string, error)` — names from `ListDatabases`.
  - `func (m *Manager) MaintenanceConn(ctx context.Context) (*pgx.Conn, error)` — connects to `postgres`.
  - `types.Config.BackupDir string \`json:"backup_dir" needed:"false"\`` resolved like `CronLogDir` but **no default** (empty stays empty).

- [ ] **Step 1:** Test `TestWriteBundle_NoS3`: against `testdb` DSN, `WriteBundle(ctx, &buf, cfg.DbName, false)` → `zip.NewReader` succeeds, has `dump.dump` with size > 0, `s3Objects == 0`; `WriteBundle(..., true)` with nil store → `errors.Is(err, ErrNoObjectStore)`. Add config_test rows: `backup_dir: "backups"` → `/repo/backups`; empty → empty.
- [ ] **Step 2:** Run `rtk go test ./internal/dbmanage ./internal/types` → FAIL (undefined).
- [ ] **Step 3:** Implement; keep `Extract`'s existing tests green.
- [ ] **Step 4:** Run same command → PASS.
- [ ] **Step 5:** Commit `refactor(dbmanage): bundle writer reusable outside HTTP; backup_dir config`.

### Task 2: Settings file + schedule math

**Files:**
- Create: `core/internal/backup/settings.go`, `core/internal/backup/schedule.go`
- Test: `core/internal/backup/settings_test.go`, `core/internal/backup/schedule_test.go`

**Interfaces:**
- Produces:
  ```go
  type Settings struct {
      Enabled       bool      `json:"enabled"`
      Frequency     string    `json:"frequency"` // hours|daily|weekly|monthly
      EveryHours    int       `json:"every_hours"`
      Time          string    `json:"time"`      // HH:MM, local to Timezone
      Timezone      string    `json:"timezone"`
      Weekdays      []int     `json:"weekdays"`
      MonthDay      int       `json:"month_day"`
      Databases     []string  `json:"databases"`
      IncludeS3     bool      `json:"include_s3"`
      RetentionDays int       `json:"retention_days"`
      UpdatedAt     time.Time `json:"updated_at"`
      NotifyTenant  uuid.UUID `json:"notify_tenant_id"` // tenant of whoever last saved: scheduled runs report there
      NotifyUser    uuid.UUID `json:"notify_user_id"`
  }
  func Defaults() Settings // disabled, daily, "02:00", "UTC", IncludeS3 true, RetentionDays 14, EveryHours 24, MonthDay 1
  func (s Settings) Validate(known []string) error // known = existing database names
  func LoadSettings(dir string) (Settings, error)  // missing file → Defaults()
  func SaveSettings(dir string, s Settings) error  // backup-config.json, temp file in dir + fsync + rename
  func NextSlot(s Settings, after time.Time) time.Time // first slot strictly after `after`
  ```
- Slot rules: `hours` — slots are today's `Time` in `Timezone` ± k·`EveryHours`; `daily` — `Time` each day; `weekly` — `Time` on each listed weekday; `monthly` — `Time` on `MonthDay`. Build local times with `time.Date(..., loc)` (Go normalizes a DST gap forward).

- [ ] **Step 1:** Table tests. `TestValidate`: rows for each range bound, bad timezone `"Europe/Pariss"`, weekly with empty weekdays, unknown database `"ghost"`, duplicate database names, `time` `"24:00"` → error; a valid row per frequency → nil. `TestNextSlot`: daily 02:00 UTC after `2026-11-22T01:59Z` → `2026-11-22T02:00Z`, after `02:00Z` → next day; weekly `[1,4]` 03:00 Europe/Paris after Sat 2026-11-21 → Mon 2026-11-23T02:00Z; monthly 28 after 2026-02-28T23:00Z → 2026-03-28; hours 6 anchored 00:30 UTC after 07:00Z → 12:30Z; DST: daily 02:30 Europe/Paris after 2026-03-28T12:00Z → 2026-03-29T01:30Z. `TestSaveLoad_RoundTrip` + `TestLoad_MissingIsDefaults`.
- [ ] **Step 2:** `rtk go test ./internal/backup` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(backup): settings file and schedule`.

### Task 3: History log, published listing, retention

**Files:**
- Create: `core/internal/backup/store.go`
- Test: `core/internal/backup/store_test.go`

**Interfaces:**
- Produces:
  ```go
  type DBResult struct {
      Name      string `json:"name"`
      File      string `json:"file"`
      Size      int64  `json:"size"`
      SHA256    string `json:"sha256"`
      S3Objects int    `json:"s3_objects"`
  }
  type Run struct {
      ID         string     `json:"id"`      // stamp
      Trigger    string     `json:"trigger"` // schedule|manual
      Slot       *time.Time `json:"slot,omitempty"`
      StartedAt  time.Time  `json:"started_at"`
      FinishedAt *time.Time `json:"finished_at,omitempty"`
      Status     string     `json:"status"` // running|success|failed|cancelled
      Error      string     `json:"error,omitempty"`
      Path       string     `json:"path,omitempty"` // "2026/11/<stamp>", success only
      Databases  []DBResult `json:"databases"`
      Warnings   []string   `json:"warnings,omitempty"`
      TotalBytes int64      `json:"total_bytes"`
      Version    string     `json:"app_version"`
  }
  func AppendHistory(dir string, r Run) error   // append, then trim to newest 500 (rewrite via temp+rename)
  func ReadHistory(dir string) ([]Run, error)    // newest first; skips unparsable lines
  type Published struct{ Path string; Stamp time.Time; Bytes int64 }
  func ListPublished(dir string) ([]Published, error) // walks YYYY/MM/<stamp> dirs whose name parses as the stamp; ignores .tmp and anything else
  func Retain(dir string, days int, now time.Time, log *zap.Logger) (removed []string, err error) // older than days, never the newest, never .tmp; logs each
  ```

- [ ] **Step 1:** Tests: `TestHistory_TrimTo500` (append 502, read 500, newest first), `TestHistory_SkipsCorruptLine`, `TestListPublished_IgnoresTmpAndStrays`, `TestRetention_RemovesOld` (3 folders aged 1/20/40 days, days=14 → only 20 and 40 removed), `TestRetention_KeepsNewest` (all aged 40 days → newest kept), `TestRetention_NeverTouchesTmp`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(backup): history and local retention`.

### Task 4: Runner — lock, build, validate, publish, cancel, schedule loop

**Files:**
- Create: `core/internal/backup/service.go`, `core/internal/backup/lock.go`
- Modify: `core/internal/notify/categories.go` (`RegisterCategory(Category{Key: "backup", Label: "Backups"})`), shell `.po`/`.pot` msgid `Backups`
- Test: `core/internal/backup/service_test.go`, `core/internal/backup/service_db_test.go`

**Interfaces:**
- Consumes: Task 1 `WriteBundle`/`DatabaseNames`/`MaintenanceConn`/`ErrNoObjectStore`; Tasks 2–3.
- Produces:
  ```go
  type Bundler interface {
      WriteBundle(ctx context.Context, w io.Writer, db string, includeS3 bool) (int, error)
      DatabaseNames(ctx context.Context) ([]string, error)
  }
  type Locker interface { TryLock(ctx context.Context) (unlock func(), ok bool, err error) }
  func PGLocker(connect func(context.Context) (*pgx.Conn, error)) Locker // pg_try_advisory_lock(7311990003) on its own conn; unlock = unlock + close
  type Notifier interface { Start(ctx context.Context, tenant uuid.UUID, a notify.Activity) (*notify.Run, error) }
  type Service struct{ /* dir, bundler, locker, notifier (may be nil), version, log, mu, current *Run, cancel context.CancelFunc */ }
  func NewService(dir string, b Bundler, l Locker, n Notifier, version string, log *zap.Logger) *Service
  var ErrBusy = errors.New("backup: a run is already in progress")
  func (s *Service) Start(trigger string, slot *time.Time, tenant, user uuid.UUID) (Run, error) // async; ErrBusy if lock held or one running here
  func (s *Service) Cancel() bool
  func (s *Service) Current() *Run
  func (s *Service) CleanupStale(ctx context.Context) error // removes .tmp/* only while holding the lock
  func (s *Service) Tick(ctx context.Context, now time.Time) // load settings; due when enabled and now >= NextSlot(s, lastScheduledSlot or UpdatedAt) → Start("schedule", &slot, NotifyTenant, NotifyUser)
  func (s *Service) Run(ctx context.Context) // CleanupStale, then Tick each minute until ctx done; on ctx done, Cancel and wait
  ```
- Run body: lock → mkdir `.tmp/<stamp>` (0700) → per database: absent from `DatabaseNames` → warning, else create `<db>.zip`, `WriteBundle` through `io.MultiWriter(file, sha256)`, `Sync`, `Close`, reopen with `zip.OpenReader` and require a `dump.dump` entry → `manifest.json` (the Run minus status fields: id, version, started/finished, trigger, databases, warnings) fsync'd → `MkdirAll(YYYY/MM)` → `os.Rename` → `Retain` → `AppendHistory(success)`. Any error or ctx cancel → `RemoveAll(.tmp/<stamp>)`, `AppendHistory(failed|cancelled, Error)`. Zero databases written (all missing) → failed. Run uses `context.WithoutCancel(parent)` + its own cancel so an HTTP request ending doesn't stop it. Notify activity (category `backup`, `Indeterminate`, link `/settings/developer`) when tenant ≠ Nil, `Progress` label = current database, `Finish(err, …)`.

- [ ] **Step 1:** Unit tests with a fake Bundler (writes a tiny zip with `dump.dump`, or blocks until ctx done, or errors) and a fake Locker:
  - `TestRun_PublishesAtomically`: while the fake bundler blocks mid-write, `ListPublished` is empty and `.tmp/<id>` exists; after release → one published folder with `<db>.zip` + `manifest.json`, checksum in manifest equals sha256 of the file, `.tmp` empty, history line `success`.
  - `TestRun_FailureLeavesNothingPublished`: second database errors → no published folder, `.tmp` empty, history `failed` with the error text.
  - `TestRun_ConcurrentRejected`: second `Start` while running → `ErrBusy`; fake locker returning `ok=false` → `ErrBusy`.
  - `TestCancel`: blocking bundler, `Cancel()` → history `cancelled`, nothing published.
  - `TestRun_MissingDatabaseIsWarning`, `TestRun_S3RequestedWithoutStore` (fake returns `ErrNoObjectStore` → failed), `TestCleanupStale_SkipsWhenLocked`, `TestTick_RunsOnceForMissedSlots` (last slot 3 days ago, daily → one run, slot = most recent due slot ≤ now).
- [ ] **Step 2:** DB-backed `TestRun_RealDatabase` (skips without testdb): real `dbmanage.Manager` + `PGLocker`, `t.TempDir()`, `include_s3` false → zip opens, `dump.dump` non-empty; and `TestPGLocker_Exclusive`: second TryLock → ok=false until unlock.
- [ ] **Step 3:** → FAIL. **Step 4:** implement. **Step 5:** → PASS with `-race`.
- [ ] **Step 6:** Commit `feat(backup): atomic runner, lock and scheduler`.

### Task 5: HTTP API, app wiring, MCP

**Files:**
- Create: `core/internal/backup/handler.go`; Test: `core/internal/backup/handler_test.go`
- Modify: `core/internal/app/app.go` (mount after devseed with `jwtMw, permMw` when `BackupDir != ""`; `go svc.Run(ctx)` in `App.Run`), `core/internal/mcpbridge/bridge.go` (add `"backups"` to admitted roots), `core/internal/app/app_test.go` route table, `core/internal/mcpbridge/server_test.go` (backups op listed; denied without permission)

**Interfaces:**
- Consumes: Task 4 `Service`, Task 2 settings, Task 3 history.
- Routes (all JSON; errors use the existing `{code, message}` shape):
  - `GET /api/v1/backups` → `{settings, backup_dir, running: Run|null, next_run: time|null, last_success: time|null, last_failure: {at, error}|null, local_count, local_bytes}`
  - `PUT /api/v1/backups` body `Settings` (client's `updated_at`/`notify_*` ignored; set from now + JWT identity) → 400 `VALIDATION_ERROR` on `Validate` error, else 200 with the GET shape
  - `GET /api/v1/backups/databases` → `{data: [name…]}`
  - `GET /api/v1/backups/runs` → `{data: [Run…], total}`
  - `POST /api/v1/backups/run` → 202 `Run`, 409 `BACKUP_RUNNING` on `ErrBusy`
  - `POST /api/v1/backups/cancel` → 200 `{cancelled: bool}`
  - `POST /api/v1/backups/cleanup` → 200 `{removed: [path…]}`

- [ ] **Step 1:** Handler tests (httptest, temp dir, fake bundler): PUT invalid → 400 and file unchanged; PUT valid → GET reflects it with `next_run`; run twice → 202 then 409; runs list newest first. `app_test` route table rows assert 403 for a role without `backups:*` and that routes are absent when `backup_dir` is empty.
- [ ] **Step 2:** → FAIL. **Step 3:** implement + wire. **Step 4:** `go test -race ./internal/backup ./internal/mcpbridge ./orm/server && go test ./internal/types ./internal/app` → PASS; `golangci-lint run ./...` clean; `make run-deadcode` clean.
- [ ] **Step 5:** Commit `feat(backup): admin API, wiring and MCP admission`.

### Task 6: Settings → Developer → Automated backups

**Files:**
- Create: `core-front/apps/shell/src/lib/backups.ts` (+ `backups.test.ts`), `core-front/apps/shell/src/components/BackupSettings.tsx` (+ `BackupSettings.test.tsx`)
- Modify: `core-front/apps/shell/src/components/DeveloperSettings.tsx` (third Accordion "Automated backups", not gated by `isDev`), `core-front/apps/shell/i18n/shell.pot` + every shell `.po`

**Interfaces:**
- Consumes: Task 5 routes.
- Produces (`'use server'`, pattern of `event-settings.ts`): `getBackups(): Promise<BackupStatus | null>`, `saveBackupSettings(s): Promise<SaveResult>`, `getBackupDatabases(): Promise<string[]>`, `getBackupRuns(): Promise<BackupRun[]>`, `runBackupNow(): Promise<SaveResult>`, `cancelBackup(): Promise<boolean>`, `cleanupBackups(): Promise<{ ok: true; removed: string[] } | { ok: false; message: string }>`; types mirror Task 3/5 JSON.
- UI: `getBackups()` null → info alert "Automated backups are not configured on this server (backup_dir)." Otherwise: overview line (enabled, next run, last success, last status, local count + size, `backup_dir` read-only); form (enable switch, database checkbox list, frequency select with conditional every-hours / weekdays / month-day fields, time, timezone autocomplete from `Intl.supportedValuesOf('timeZone')`, include S3 checkbox, retention days with helper "Keep this well above Backrest's snapshot interval."); buttons Save / Run now / Cancel (while running) / Clean up now; history table (ID, start, end, duration, status chip, databases, size, error) — cards on phone like other settings tables. Poll `getBackups()` every 5 s while `running`.

- [ ] **Step 1:** Tests: lib maps 409 to `{ok:false, message}`; component renders the not-configured alert on null; shows checkbox per database; weekly reveals weekday picker; Save calls `saveBackupSettings` with the edited settings; Run now disabled while running and Cancel shown; history row shows status and error.
- [ ] **Step 2:** `rtk vitest run` (shell) → FAIL. **Step 3:** implement. **Step 4:** shell lint + typecheck + tests → PASS, coverage ≥ 80%.
- [ ] **Step 5:** Commit `feat(settings): automated backups section`.

### Task 7: Production compose, docs, full check

**Files:**
- Modify: `compose.prod.yml` (core-back `volumes: !override` adds `eerp-backups:/app/backups`; top-level `eerp-backups:`; a commented Backrest example service mounting `eerp-backups:/backup-output:ro`), `infra/bootstrap-prod.sh` (writes `"backup_dir": "/app/backups"` into the generated prod config if absent)
- Create: `docs/adr/ADR-044-automated-backups.md` (files not tables and why; atomic publish; lock; Backrest contract: read-only mount, statuses independent, retention ≫ snapshot interval; mermaid flow)
- Modify: `CLAUDE.md` (`internal/backup/` bullet; `backup_dir` under Configuration), `docs/mcp.md` (backups operations), `README.md` link if ADR index lives there

- [ ] **Step 1:** `docker compose -f compose.yml -f compose.prod.yml config` → valid, `eerp-backups` mounted on core-back only; `docker compose config` (dev) → no backup volume.
- [ ] **Step 2:** Dev smoke: `make run`, enable a run from the UI on `poc` with S3 → `backups/YYYY/MM/<stamp>/poc.zip` + `manifest.json`; restore that zip via `/database/management` under a new name succeeds.
- [ ] **Step 3:** `make test` → green.
- [ ] **Step 4:** `graphify update .`; commit `docs(backup): ADR-044, prod volume, Backrest contract`.
