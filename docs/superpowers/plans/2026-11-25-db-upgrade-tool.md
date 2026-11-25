# Database Upgrade Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local CLI, `tools/eerp-upgrade`, that turns a `/database/management` extract zip from an older EERP release (≥ v0.108.0) into an extract zip of the current release (or of `-to <tag>`), verified against a fresh schema.

**Architecture:** The tool restores the input dump into a temporary database on the configured Postgres, runs the target release's own boot migration on it (in-process through `dbmanage.Provisioner` for the tool's own version, or by booting that tag's built `core` binary for `-to`), compares its catalog with a freshly provisioned reference database, then writes a new zip (fresh `dump.dump`, input `manifest.json` + `s3/*` copied raw, `version.json`). Temporary databases are always dropped.

**Tech Stack:** Go (own module `core/tools/eerp-upgrade`, `replace core => ../../core`), pgx, `pg_dump`/`pg_restore` 18, `git worktree`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-25-db-upgrade-tool-design.md`

## Global Constraints

- Floor: inputs and `-to` targets older than **v0.108.0** are refused.
- Forward only: an input whose `version.json` is newer than the target is refused (exit 1, nothing written). Equal is allowed. `dev` compares newer than every release. No `version.json` = "≥ v0.108.0, older than this change".
- Never write to the config's `db_name` database nor to S3. Temporary database names match `^[a-z][a-z0-9_]{0,62}$`: `eerp_upgrade_tmp_<8 hex>`, `eerp_upgrade_ref_<8 hex>`.
- `Provision` always runs with `Environment: "production"`.
- Schema check is one-directional: missing/different vs the reference fails; extras are warnings.
- `version.json` content: `{"version":"<x.y.z or dev>"}`, no leading `v`.
- Not part of `make test` nor of `test-check.yml`/`test-build.yml`; its own `make test-upgrade` and its own workflow, triggered by `tools/eerp-upgrade/**` and `workflow_dispatch`. No coverage floor, no badge.
- Repo rules: `rg` never `grep` (scripts too), zap logging via `common.Logger` (no `fmt`/`log` in core; the tool's `main` may print its report with `os.Stdout` writes), commit format `<type>(scope): …`, docs in English, `make run-deadcode` stays green.

## Review Focus

1. **Ctrl-C / failure mid-run** → both temporary databases and the `-to` worktree are still removed; `-out` is not left half-written (write to `<out>.partial`, rename at the end). Test: Task 4 `TestRun_FailureCleansUp`.
2. **Existing `-out` file** → refused unless `-force`, before any database work. Test: Task 2 `TestValidateArgs`.
3. **Input zip without `dump.dump`, or not a zip** → clear error, no database created. Test: Task 2 `TestOpenInput`.
4. **PostGIS-owned objects** (`spatial_ref_sys`, postgis functions in `public`) and extension objects → never part of the diff (would make every run fail). Test: Task 3 `TestLoadSchema_FreshDatabasesMatch`.
5. **`-to` with an unknown tag, or run outside a git checkout** → error before any database work. Test: Task 5 `TestPrepareRelease_UnknownTag`.

---

### Task 1: `dbmanage` exports the pieces the tool needs, and every bundle records its version

**Files:**
- Modify: `core/internal/dbmanage/catalog.go` (rename `connInfo` → `Conn`; add `ConnFromConfig`), `manager.go`, `dump.go`, `s3manifest.go`, `extract.go`, `restore.go`, tests using `connInfo`
- Test: `core/internal/dbmanage/bundle_test.go`

**Interfaces:**
- Produces:
  - `type Conn struct{ Host string; Port int; User, Password string }` (the old `connInfo`, method `dsn` kept unexported) + `func (c Conn) DSN(dbName string) string` (exported wrapper or rename of `dsn`).
  - `func ConnFromConfig(cfg *types.Config) Conn` — used by `NewManager` and `EnsureDatabaseExists` (keeps it reachable for the dead code gate).
  - `func PgDump(ctx, conn Conn, dbName string, w io.Writer) error`, `func PgRestore(ctx, conn Conn, dbName, dumpPath string) error` (renames; `dumpDB` var stays, pointing at `PgDump`).
  - `CreateDatabase(ctx, Conn, name)`, `DropDatabase(ctx, Conn, name, activeName)` — unchanged besides the type.
  - `const VersionEntry = "version.json"`; `type VersionFile struct{ Version string \`json:"version"\` }`; `writeBundle` writes `VersionEntry` with `version.Version` (`core/internal/version`) as the first entry, always.

- [ ] **Step 1: Failing test** `TestWriteBundle_RecordsVersion` in `bundle_test.go`: with `dumpDB` stubbed (as the existing bundle tests do) and `version.Version` set to `"0.170.0"` for the test (restore after), `WriteBundle(ctx, &buf, "x", false)` → the zip has `version.json` decoding to `VersionFile{Version: "0.170.0"}` and still has `dump.dump`.
- [ ] **Step 2:** `cd core && go test ./internal/dbmanage -run TestWriteBundle_RecordsVersion` → FAIL (no entry).
- [ ] **Step 3:** Rename `connInfo` → `Conn` package-wide (`gofmt -r 'connInfo -> Conn' -w internal/dbmanage`), add `ConnFromConfig` and use it in both call sites, rename `pgDump`/`pgRestore` → `PgDump`/`PgRestore`, write `version.json` in `writeBundle`. Restore needs no change (it opens entries by name).
- [ ] **Step 4:** `go test ./internal/dbmanage/...` → PASS; `cd .. && make run-deadcode` → no new dead code; `cd core && golangci-lint run ./internal/dbmanage/...` → clean.
- [ ] **Step 5:** Commit `feat(dbmanage): record the EERP version in every extract and backup zip`.

---

### Task 2: Tool skeleton — flags, versions, zip in/out (no database)

**Files:**
- Create: `tools/eerp-upgrade/go.mod` (module `core/tools/eerp-upgrade`, `go` = core's version, `require core v0.0.0` + `replace core => ../../core`; `go mod tidy`), `main.go`, `versions.go`, `bundle.go`
- Test: `tools/eerp-upgrade/versions_test.go`, `bundle_test.go`, `main_test.go`

**Interfaces:**
- Consumes: `dbmanage.VersionEntry`, `dbmanage.VersionFile`, `version.Version`.
- Produces:
  - `const floor = "0.108.0"`
  - `func compareVersions(a, b string) (int, error)` — strips a leading `v`, compares numeric `X.Y.Z`; `"dev"` > any release, `dev == dev`; anything else unparsable → error. A `-pr.N` suffix ranks just below its `X.Y.Z`.
  - `func checkRange(input, target string) error` — `input == ""` (no `version.json`) passes; refuses target < floor, input < floor, input > target. Error texts name both versions.
  - `type args struct{ ConfigPath, In, Out, To string; Force bool }`; `func parseArgs(argv []string) (args, error)`; `func validateArgs(a args) error` (in/out/config required; `In` must exist; `Out` must not exist unless `Force`; `Out != In`).
  - `type input struct{ zip *zip.ReadCloser; Version string }`; `func openInput(path string) (*input, error)` — refuses non-zip and a zip without `dump.dump`; reads `version.json` if present.
  - `func (in *input) extractDump(dst string) error`
  - `func writeOutput(ctx context.Context, out string, in *input, targetVersion string, dump func(io.Writer) error) error` — writes `<out>.partial`: `version.json` (target), `dump.dump` from `dump`, then every input entry except `dump.dump`/`version.json` copied with `zip.Writer.Copy` (raw, no recompress); renames to `out` on success, removes the partial on error.
- `main.go`: `-config`, `-in`, `-out`, `-to`, `-force`, `-debug`; `common.InitLogger`, decode config like `core/cmd/app/main.go` (`common.DecodeJSON[*types.Config]` + `ResolvePaths`), `signal.NotifyContext(SIGINT, SIGTERM)`, call `run` (Task 4), print the report, exit 1 on error.

- [ ] **Step 1: Failing tests:**
  - `TestCompareVersions` table: `("0.108.0","0.170.0")=-1`, `("v0.170.0","0.170.0")=0`, `("dev","0.999.0")=1`, `("0.170.0-pr.3","0.170.0")=-1`, `("0.9.0","0.10.0")=-1`, `("garbage","0.1.0")` → error.
  - `TestCheckRange`: `("", "0.170.0")` ok; `("0.150.0","0.170.0")` ok; `("0.170.0","0.170.0")` ok; `("0.171.0","0.170.0")` error containing `newer`; `("0.100.0","0.170.0")` error; `("", "0.100.0")` error; `("dev","0.170.0")` error.
  - `TestValidateArgs`: existing `Out` without `Force` → error; with `Force` → ok; `Out == In` → error; missing `In` file → error.
  - `TestOpenInput`: non-zip file → error; zip without `dump.dump` → error; zip with `dump.dump` only → `Version == ""`; with `version.json` `{"version":"0.150.0"}` → `"0.150.0"`.
  - `TestWriteOutput`: input zip with `dump.dump`, `version.json` (0.150.0), `manifest.json`, `s3/t/a.png` → output has `version.json` = target, the new dump bytes, `manifest.json` and `s3/t/a.png` byte-identical, no old `version.json`; a `dump` func returning an error → no `out` file and no `.partial` left.
- [ ] **Step 2:** `cd tools/eerp-upgrade && go test ./...` → FAIL (undefined).
- [ ] **Step 3:** Implement the signatures above.
- [ ] **Step 4:** `go test ./... && go vet ./...` → PASS.
- [ ] **Step 5:** Commit `feat(eerp-upgrade): CLI skeleton, version range and zip handling`.

---

### Task 3: Schema snapshot and one-directional diff

**Files:**
- Create: `tools/eerp-upgrade/schema.go`, `provision.go`
- Test: `tools/eerp-upgrade/schema_test.go`, `testhelpers_test.go`

**Interfaces:**
- Produces:
  - `type Schema map[string]string` — key → normalized definition. Keys: `column:<table>.<col>` → `type|nullable|default|generated-expr`; `index:<name>` → `pg_indexes.indexdef`; `constraint:<table>.<name>` → `pg_get_constraintdef`; `trigger:<table>.<name>` → `pg_get_triggerdef`; `function:<name>(<identity args>)` → `pg_get_functiondef`. Schema `public` only; skip every object owned by an extension (`pg_depend.deptype = 'e'`, for tables via `pg_class`, functions via `pg_proc`) and internal triggers (`tgisinternal`).
  - `func loadSchema(ctx context.Context, conn *pgx.Conn) (Schema, error)`
  - `type Diff struct{ Missing, Changed, Extra []string }` — `Changed` entries read `<key>: want <ref def> got <def>`; all sorted.
  - `func diffSchemas(ref, got Schema) Diff`; `func (d Diff) Failed() bool` (= `len(Missing)+len(Changed) > 0`).
  - `func provision(ctx context.Context, cfg *types.Config, dbName string) error` — opens a pool on `dbName` (copy of cfg with `DbName` replaced, `orm.New(cfg.PoolConfig(cfg.DSN()), common.Logger)`), builds the wasmtime engine/linker exactly like `internal/app.Build` (NewEngine, NewLinker, DefineWasi, `host.log` FuncWrap), runs `dbmanage.Provisioner{Engine, Linker, ModuleRoots: cfg.ModuleRoot, Environment: "production"}.Provision(ctx, db, nil)`, closes the pool. Blank-imports `_ "core/modules/all"`.
  - Test helpers (`testhelpers_test.go`): config from `core/internal/testdb.Config(t)` (skips without `CONFIG`/`TEST_DSN`), `func freshDB(t, cfg) (name string)` — creates `eerp_upgrade_t_<hex>`, runs `provision` on it, drops it in `t.Cleanup`.

- [ ] **Step 1: Failing tests:**
  - `TestDiffSchemas`: ref `{a:1,b:2,c:3}`, got `{a:1,b:9,d:4}` → `Missing=[c]`, `Changed=["b: want 2 got 9"]`, `Extra=[d]`, `Failed()==true`; got = ref plus extras only → `Failed()==false`.
  - `TestLoadSchema_FreshDatabasesMatch` (DB): two `freshDB`s → `diffSchemas` empty in all three lists; the snapshot contains `column:users.email` and no key mentioning `spatial_ref_sys` or `st_`-prefixed functions.
  - `TestLoadSchema_DetectsDrift` (DB): on one fresh DB `ALTER TABLE contact DROP COLUMN phone` and `CREATE INDEX trgm_x ON users (email)` → diff vs the other: `Missing` has `column:contact.phone`, `Extra` has `index:trgm_x`.
- [ ] **Step 2:** `CONFIG=$PWD/../../eerp-config.json go test ./... -run 'Diff|LoadSchema'` → FAIL.
- [ ] **Step 3:** Implement (order-insensitive: no ordinal positions in any definition).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(eerp-upgrade): catalog snapshot and schema diff`.

---

### Task 4: In-process upgrade pipeline (default target) with upgrade steps

**Files:**
- Create: `tools/eerp-upgrade/run.go`, `steps.go`, `report.go`
- Test: `tools/eerp-upgrade/run_test.go`, `steps_test.go`

**Interfaces:**
- Consumes: Tasks 1–3 (`provision`, `loadSchema`, `diffSchemas`, `openInput`, `writeOutput`, `checkRange`).
- Produces:
  - `type Step struct{ Release string; Pre bool; Name string; Run func(ctx context.Context, db *orm.DB) error }`; `var steps []Step` (empty in v1, doc comment = the rule: idempotent, detects by schema whether it applies); `func stepsFor(target string, pre bool) []Step` — steps with `Release <= target`, in `Release` order.
  - `type migrator interface{ Migrate(ctx context.Context, dbName string) error; Version() string }` — `inProcess{cfg}` (calls `provision`, `Version()` = `version.Version`); Task 5 adds the release one.
  - `func run(ctx context.Context, cfg *types.Config, a args) (Report, error)`: open input → `checkRange(in.Version, m.Version())` → create tmp DB (`dbmanage.CreateDatabase`) → extract + `dbmanage.PgRestore` → pre steps → `m.Migrate(tmp)` → post steps → create + `m.Migrate(ref)` → `loadSchema` both → `diffSchemas` → if `Failed()` return error with the report → `writeOutput(..., m.Version(), PgDump(tmp))`. Deferred `DropDatabase` of both with `context.WithoutCancel` (so Ctrl-C still cleans up), `activeName = cfg.DbName`. Database work never starts before `validateArgs`/`openInput`/`checkRange` pass.
  - `type Report struct{ In, Out, Target, Source string; Diff Diff; S3Objects int; Duration time.Duration }` + `func (r Report) String() string` (Source `"unknown (≥ 0.108.0)"` when empty; lists Missing/Changed as errors, Extra as warnings).

- [ ] **Step 1: Failing tests:**
  - `TestStepsFor`: steps `{0.150.0 pre}`, `{0.180.0 pre}`, `{0.160.0 post}` → `stepsFor("0.170.0", true)` = only the 0.150.0 one; `stepsFor("dev", true)` = both pre, ordered.
  - `TestRun_RoundTrip` (DB): build an input zip from a `freshDB` with one inserted contact (`dbmanage.PgDump` + a `manifest.json` + `s3/k` entry) → `run` → report `Diff.Failed()==false`; output restores (`CreateDatabase` + `PgRestore`) and has the contact; `s3/k` byte-identical; `version.json` = `version.Version`; no database named `eerp_upgrade_%` remains (`pg_database`).
  - `TestRun_RefusesNewerInput` (DB config needed only for skip): input `version.json` `{"version":"dev"}` with `version.Version="0.170.0"` → error, no output, no `eerp_upgrade_%` database created.
  - `TestRun_FailureCleansUp` (DB): a migrator stub whose `Migrate` returns an error → `run` errors; no `eerp_upgrade_%` database left; no `out`/`.partial`.
  - `TestRun_DriftFails` (DB): migrator stub that provisions then `ALTER TABLE contact DROP COLUMN phone` on the tmp DB only → error, report lists `column:contact.phone`, no output.
- [ ] **Step 2:** `CONFIG=$PWD/../../eerp-config.json go test ./... -run 'StepsFor|Run_'` → FAIL.
- [ ] **Step 3:** Implement; `run` takes the migrator through a small seam (`runWith(ctx, cfg, a, m migrator)`; `run` picks `inProcess` or Task 5's) so tests inject stubs.
- [ ] **Step 4:** Same command → PASS; `go build ./...` → OK; manual: `go run . -config ../../eerp-config.json -in <an extract from /database/management> -out /tmp/x.zip` prints a report with no errors.
- [ ] **Step 5:** Commit `feat(eerp-upgrade): in-process upgrade with schema verification`.

---

### Task 5: `-to <tag>` — boot a past release to migrate

**Files:**
- Create: `tools/eerp-upgrade/release.go`
- Test: `tools/eerp-upgrade/release_test.go`

**Interfaces:**
- Consumes: `migrator` (Task 4), `checkRange`/`compareVersions` (Task 2).
- Produces:
  - `type release struct{ tag, version, worktree, bin string; cfg map[string]any }`
  - `func prepareRelease(ctx context.Context, cfgPath, tag string) (*release, error)` — `git rev-parse --show-toplevel` (error "run from an EERP git checkout" otherwise), `git rev-parse --verify --quiet refs/tags/<tag>` (unknown → error before anything else), `git worktree add --detach <tmp> <tag>`, `go build -C <tmp>/core -ldflags "-X core/internal/version.Version=<tag without v>" -o <tmp>/eerp ./cmd/app`. Loads the user's config file as `map[string]any`.
  - `func (r *release) Close() error` — `git worktree remove --force <tmp>` (with `context.WithoutCancel`).
  - `func (r *release) Version() string`; `func (r *release) Migrate(ctx context.Context, dbName string) error` — writes `<tmp>/upgrade-config.json` = user config with: `db_name`=dbName, `environment`=`production`, `backend_port`=a free port (`net.Listen("tcp","127.0.0.1:0")`, closed), `backend_host`=`127.0.0.1`, `module_root`=`["<tmp>/core/modules"]`, and emptied `s3_endpoint s3_bucket s3_access_key s3_secret_key nats_url redis_url smtp_host pdf_service_url frontend_base_url backup_dir mcp_enabled(false) mcp_oauth_issuer cron_log_dir(<tmp>/cron-logs)`; starts `<bin> -config <that file>` with output captured; polls `GET http://127.0.0.1:<port>/health` every 500 ms until 200 (timeout **5 min**, or the process exits → error with the last 50 log lines); then SIGTERM and wait (10 s, then kill).
  - `run` picks `release` when `a.To != ""` and its version ≠ `version.Version`, deferring `Close`. Steps (`stepsFor`) use `r.Version()`.

- [ ] **Step 1: Failing tests:**
  - `TestPrepareRelease_UnknownTag`: `prepareRelease(ctx, cfg, "v0.0.0-nope")` → error mentioning the tag; `git worktree list` unchanged.
  - `TestReleaseConfig`: the config-writing function (`func releaseConfig(user map[string]any, worktree, dbName string, port int) map[string]any`) → keys above set/emptied, every other user key preserved.
  - `TestRelease_Migrate` (slow; skipped unless `EERP_UPGRADE_SLOW=1` and `CONFIG`): `prepareRelease` at `v0.108.0`, `Migrate` an empty `eerp_upgrade_t_*` DB → `users` and `event` tables exist, `project` table does not (it postdates v0.108.0); worktree gone after `Close`.
- [ ] **Step 2:** `go test ./... -run 'Release'` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `EERP_UPGRADE_SLOW=1 CONFIG=$PWD/../../eerp-config.json go test ./... -run Release -timeout 20m` → PASS.
- [ ] **Step 5:** Commit `feat(eerp-upgrade): -to upgrades to a past release by booting it`.

---

### Task 6: v0.108.0 fixture and the end-to-end test

**Files:**
- Create: `tools/eerp-upgrade/fixture_test.go`, `testdata/seed-v0.108.0.sql`, `testdata/v0.108.0.zip` (generated)
- Test: `tools/eerp-upgrade/e2e_test.go`

**Interfaces:**
- Consumes: `prepareRelease`/`Migrate` (Task 5), `dbmanage.PgDump`, `run` (Task 4).

- [ ] **Step 1:** `TestMakeFixture` (runs only with `EERP_MAKE_FIXTURE=1`): `prepareRelease(v0.108.0)` → `Migrate` an empty DB → apply `testdata/seed-v0.108.0.sql` → write `testdata/v0.108.0.zip` with only `dump.dump` (no `version.json`, as a real v0.108.0 extract). The seed SQL targets v0.108.0's schema (read it from the worktree, `git show v0.108.0:core/modules/...`) and inserts, under one fresh tenant: a company, a contact, a product with a non-zero legacy tax rate and a variant, a quote with a line, an event with a session and a booking (exercises the contact backfill and product-tax migration), a website page. Keep the zip under 1 MB.
- [ ] **Step 2:** `cd tools/eerp-upgrade && EERP_MAKE_FIXTURE=1 CONFIG=$PWD/../../eerp-config.json go test -run TestMakeFixture -timeout 20m` → creates the zip; commit it.
- [ ] **Step 3: Failing test** `TestUpgradeFrom_v0_108_0` (DB): `run` on `testdata/v0.108.0.zip` (default target) → no `Diff.Failed()`; restore the output in a scratch DB → the booking has a non-null `contact_id`, the product has ≥ 1 `product_tax` row, the event session has `remaining_seats` = capacity − seats_taken, `project` table exists; output `version.json` = `version.Version`.
- [ ] **Step 4:** `CONFIG=$PWD/../../eerp-config.json go test ./... -run UpgradeFrom` → PASS (if it fails on a missing data migration, that is a real finding: add a `Step` in `steps.go` per the spec rather than editing the assertion).
- [ ] **Step 5:** Commit `test(eerp-upgrade): v0.108.0 fixture upgraded end to end`.

---

### Task 7: Make targets, CI workflow, documentation

**Files:**
- Modify: `Makefile`, `CLAUDE.md`, `README.md`
- Create: `.github/workflows/upgrade-tool.yml`, `tools/eerp-upgrade/README.md`

- [ ] **Step 1: Makefile** (add to `.PHONY`, not to `test`):
  - `build-upgrade`: `cd $(root)/tools/eerp-upgrade && go build -ldflags "-X core/internal/version.Version=$$(git describe --tags --exact-match 2>/dev/null | sed 's/^v//' || echo dev)" -o $(root)/bin/eerp-upgrade .` (an untagged checkout stays `dev`).
  - `test-upgrade`: `$(COMPOSE) up -d --wait db` then `cd $(root)/tools/eerp-upgrade && CONFIG="$(CONFIG)" EERP_UPGRADE_SLOW=1 go test ./... -timeout 30m $(ARGS)`.
  - Check `bin/` is gitignored; add it if not.
- [ ] **Step 2: Workflow** `.github/workflows/upgrade-tool.yml`: `on: push`/`pull_request` with `paths: ['tools/eerp-upgrade/**', '.github/workflows/upgrade-tool.yml']` + `workflow_dispatch`; one job copying `core-test-and-coverage`'s `postgis/postgis:18-3.7` service and config-creation step, `fetch-depth: 0` (tags for `-to`), PGDG `postgresql-client-18` install, `setup-go` from `tools/eerp-upgrade/go.mod`, then `cd tools/eerp-upgrade && CONFIG=$PWD/../../eerp-config.json EERP_UPGRADE_SLOW=1 go test ./... -timeout 30m`. Not referenced by `test-check.yml`/`test-build.yml`.
- [ ] **Step 3: `tools/eerp-upgrade/README.md`:** why (Odoo-upgrade-style: old extract in, upgraded copy out, live DB untouched), usage (`make build-upgrade`, the command line, `-to`), the flow diagram from the spec, what a verification failure means, how to add a step (release, pre/post, idempotent), requirements (dev stack Postgres, pg 18 client tools, git + Go for `-to`), pitfalls (run from the target tag's checkout for a release build; an input without `version.json` is trusted as ≥ v0.108.0; S3 bytes are carried, never uploaded).
- [ ] **Step 4: `CLAUDE.md`:** in Commands, `make build-upgrade` / `make test-upgrade` with one line each; a short section "Database upgrade tool" under Conventions: *when a change renames, drops or retypes a column or table, or removes a one-time backfill from a `Migrate()`, add an upgrade step to `tools/eerp-upgrade/steps.go` in the same change (release = the next expected version) and run `make test-upgrade`.* Also mention in the `internal/dbmanage/` paragraph that every extract/backup zip carries `version.json`. Remove the duplicated `make build` / `make rebuild-and-run` / scaffold block while editing Commands only if trivially adjacent — otherwise leave it.
- [ ] **Step 5: `README.md`:** one paragraph after "Day to day" pointing at `tools/eerp-upgrade/README.md` for upgrading an extract from an older release. (The Developer Guide lives in the separate wiki repo — out of this change; note it in the PR.)
- [ ] **Step 6:** `make test-upgrade` → PASS; `make test` → PASS (unchanged scope, Task 1 touched core); `graphify update .`.
- [ ] **Step 7:** Commit `docs(eerp-upgrade): make targets, CI workflow and upgrade rule`.

MCP impact: none — no API route, model, field or permission changes (`version.json` is a zip entry only).
