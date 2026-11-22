# Automated backups — design

## Why

Backrest/Restic snapshots a folder and ships it to Garage S3, encrypted, with its own
retention. EERP's job is to fill that folder, on a schedule, with complete, restorable
backup bundles — never a half-written one. EERP knows nothing about Restic: a published
bundle means "EERP generated it", not "Restic uploaded it"; those are separate statuses.

## Goals

- Pick, from the list of EERP databases on the server, which ones a backup covers.
- One `<db_name>.zip` per database, **S3 objects included** — exactly the zip
  `/database/management` already extracts and restores (`dump.dump` + `manifest.json` +
  `s3/<key>`), so any bundle restores through the existing UI.
- A schedule (every X hours / daily / weekly on chosen days / monthly), time of day,
  timezone; on/off; "Run now"; cancel a running run.
- Atomic publication, local retention in days, manual cleanup, run history with errors.
- Settings → Developer → Automated backups.

## Non-goals (skipped on purpose)

- Restic/Backrest integration, Restic status.
- A database or tables for backup metadata (see Approaches).
- Uploading bundles to S3 from EERP — Backrest already ships them to Garage.
- Downloading bundles from the UI — the bundles hold every database on the server;
  today that power is master-key-gated (`/database/management` → Extract). Read them from
  the volume, or extract through the database manager.
- Parallel dumps within a run ("max concurrent jobs"): one run at a time, databases one
  after another. Disk and Postgres I/O are the bottleneck, not CPU.
- Editing the output directory from the UI (path traversal surface): it's config.

## Approaches

1. **JSON files in the backup folder (picked).** Settings, history and the next run all
   derive from files next to the bundles; a Postgres advisory lock on the server's
   `postgres` database prevents double runs. No new infrastructure; survives database
   switch/delete/restore; Backrest snapshots the settings too.
2. A hidden `eerp_backups` database on the same server — real SQL history, but a
   database to provision for metadata nobody needs to query.
3. A dedicated Postgres container (prod only) — one more service, and dev needs a second
   code path.

Settings can't live in the active app database: dbmanage switches, deletes and restores
it, and a schedule covering several databases would vanish or regress with it.

## Design

### Config

- `backup_dir` in `eerp-config.json` (relative paths resolve against the config file's
  directory, like `cron_log_dir`). Unset → the feature isn't mounted (UI says so).
- Dev: `backups` (gitignored). Prod: `/app/backups` on a named volume `eerp-backups`
  (`compose.prod.yml`), which Backrest mounts `:ro`. Dev compose mounts nothing extra.
- `core/Dockerfile` already ships `pg_dump`.

### Folder layout

```text
<backup_dir>/
├── backup-config.json       settings, written temp file + rename
├── history.jsonl            one line per finished run, newest 500 kept
├── .tmp/<run id>/           a run in progress — never read by anyone
└── YYYY/MM/<YYYY-MM-DDTHHMMSSZ>/
    ├── <db>.zip
    └── manifest.json        run id, app version, started/finished, trigger,
                             per database: file, size, sha256, s3 object count
```

### Settings (`backup-config.json`)

`enabled`, `frequency` (`hours`|`daily`|`weekly`|`monthly`), `every_hours` (1–168),
`time` (`HH:MM`), `timezone` (IANA, validated with `time.LoadLocation`), `weekdays`
(weekly), `month_day` (1–28, monthly), `databases` (names), `include_s3` (default true),
`retention_days` (≥ 1, default 14). Missing file = disabled defaults.

### Run

1. Trigger: the scheduler (once due) or "Run now". Take `pg_try_advisory_lock` on a
   dedicated connection to `postgres`; held → 409 (manual) / skip (scheduler).
2. Per selected database (skipping ones that no longer exist, recorded as a warning):
   stream the existing extract logic into `.tmp/<run>/<db>.zip` — `Extract` is split so
   the zip writing takes an `io.Writer` (HTTP response or file), not an echo context.
3. Validate: `fsync`, reopen each zip with `archive/zip` (central directory readable,
   `dump.dump` present), compute SHA-256.
4. Write `manifest.json`, fsync, `rename(.tmp/<run>, YYYY/MM/<stamp>)` — same filesystem
   by construction. Only then append a `success` line to `history.jsonl`.
5. Failure/cancel: remove `.tmp/<run>`, append a `failed`/`cancelled` line with the error
   (no credentials: pg_dump's stderr is already logged without the password, env-passed).
   Disk full surfaces as a write error → `failed`.
6. Progress: a `notify` activity in the active database (category `backup`), so the bell
   shows it live; a failed scheduled run notifies via that activity's failure.

### Scheduler

A one-minute ticker in `App.Run`. `next = first slot after the last scheduled run's
slot` (from `history.jsonl`; none yet → after the settings' save time). If `now ≥ next`
it runs — so a run missed while the app was down happens once at the next boot, not
once per missed slot. Shutdown cancels the run's context (pg_dump is killed, `.tmp`
removed). At boot, `.tmp/*` is removed only while holding the lock (a crashed run's
leftovers, never another replica's live run).

### Retention

After each run and on "Clean up now": delete published `YYYY/MM/<stamp>` folders older
than `retention_days`, never `.tmp`, never the newest bundle; log each deletion. Keep
retention well above Backrest's snapshot interval (UI hint), since a deletion while
Backrest reads would drop that bundle from that snapshot.

### API (`internal/backup`, JWT + route-derived permissions)

- `GET /api/v1/backups` — settings, status (`running` + run id + current database),
  next run, last success/failure, local bundle count + total size, `backup_dir`.
- `PUT /api/v1/backups` — settings (validated; unknown database names → 400).
- `GET /api/v1/backups/databases` — the picker (`dbmanage.ListDatabases`).
- `GET /api/v1/backups/runs` — history, newest first.
- `POST /api/v1/backups/run`, `POST /api/v1/backups/cancel`, `POST /api/v1/backups/cleanup`.

Permissions `backups:backups:read|write`, held by no seeded role but `*:*:*` admins —
these routes act on every database on the server, not just the caller's tenant.
MCP: `/api/v1/backups` admitted in `mcpbridge` (read + run/cancel/cleanup behind the same
permissions).

### Frontend

A third accordion "Automated backups" on `DeveloperSettings` (not gated by `isDev`):
overview line, settings form (database checklist, frequency fields, timezone, retention),
Run now / Cancel / Clean up buttons, history table (id, start, end, duration, status,
databases, size, error). i18n strings in the shell `.pot`/`.po`.

### Tests

Go: schedule math (table-driven, DST, monthly), atomic publish (failure leaves nothing
published), lock prevents a second run, retention never touches `.tmp`/newest,
config validation, handlers (403 without permission). DB-backed: one real run into a
temp dir against the test DB (zip opens, `dump.dump` present, checksum matches).
Frontend: the accordion's form and actions (vitest).

### Docs

ADR-044 (backups as files; why no metadata database; Backrest contract), CLAUDE.md
`internal/backup` entry, `docs/mcp.md`, deployment guide: the Backrest compose snippet.
