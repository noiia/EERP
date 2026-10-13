# List Read Performance (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generic list endpoint's cold reads cost the same at 100k rows as at 1k. The framework does this by itself: every eligible text column of every module gets an automatic trigram index, and every list gets a bounded total, with no per-module code.

**Architecture:** There are two framework-level mechanisms, each written once:
1. **Bounded list totals.** `query.SelectBuilder` gains `CountUpTo` (an exact count capped at N+1 rows) and `EstimateRows` (the planner's estimate from `EXPLAIN`). `crud.Repository.FindAll` counts exactly up to `ExactCountLimit` (10 000) and returns the planner estimate beyond it, flagged with `total_estimated: true` in the envelope.
2. **Automatic search indexes.** A new `core/internal/searchindex` package derives candidate columns from the ORM registry (TEXT columns of exposed tables). A compliance policy then checks each candidate against Postgres statistics (table size, value width, cardinality). The package creates a `gin_trgm_ops` index `CONCURRENTLY` for every column that passes, and repairs indexes left invalid by an interrupted build. A maintainer runs it right after boot and then hourly from `App.Run`; dev seeding also calls it directly.

**Tech Stack:** Go 1.27, pgx v5, PostgreSQL 18 + `pg_trgm`, Echo, Next.js / React / MUI X DataGrid v9, Vitest.

**Spec:** this plan is self-contained. The measurements below are its requirements, and Task 6 records the decision as ADR-031.

### Measurements this plan is built on (live dev stack, 100k contacts/crm rows, 2026-10-13)

| Request (cold, Redis miss) | p50 | Where the time goes |
|---|---|---|
| `GET /contact?page=N&page_size=50` | 46 ms | `count(*)` scans all 100k rows (~22 ms); page itself is cheap |
| `GET /crm?page=N&page_size=50` | 54 ms | same |
| `GET /contact?search[name]=x` | 131 ms (p90 236) | `name::text ILIKE '%x%'` seq scan **twice** (count + page), ~50 ms each |
| JSON encode/decode of a 50-row page | ~0.4 ms | negligible |

Verified before writing this plan:
- A `gin (name gin_trgm_ops)` index turns the ORM's exact SQL `name::text ILIKE '%' || $1 || '%'` into a Bitmap Index Scan: 50 ms → 0.03–0.3 ms, under both custom and **generic** (cached prepared statement) plans.
- pgx binds parameters into `EXPLAIN (FORMAT JSON) …`. The planner estimated 100 048 rows for 100 013 real ones.

### Out of scope (measured and rejected, do not add)
- **Keyset pagination:** the DataGrid uses numbered pages and users don't page deep. A cold page with a shallow `OFFSET` already costs ~5 ms once the count is bounded (the `invoice` list measured 5 ms).
- **Custom JSON row encoder:** it saves ≤0.2 ms per request, which is below noise.
- **gRPC:** see the analysis in the conversation that produced this plan.

## Global Constraints

- Search with `rg`, never `grep`. Prefix shell commands with `rtk` (project CLAUDE.md).
- Go is at `/usr/local/go/bin`: `export PATH=$PATH:/usr/local/go/bin`. DB tests need `CONFIG=/home/noia/development/EERP/eerp-config.json`, and always run with `-timeout`.
- Go tests are table-driven with `t.Run` subtests. `depguard` forbids `fmt` printing and `log`; log via `common.Logger` (zap). `fmt.Errorf`/`fmt.Sprintf` are fine.
- DB-backed tests may hit the live dev DB: create a uniquely named table and drop **only** that table. Never touch other tables.
- ERP code imports only the `core/orm` facade. `core/orm/...` internals and `core/internal/...` follow existing placement.
- Commits use `git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit`, format `<type>(scope): <description>`, and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Frontend: `npx -y pnpm@12.4.2` from `core-front/`. After changing `packages/core-front`, rebuild it (`npx -y pnpm@12.4.2 build` in `packages/core-front`) before running shell tests. Never run Prettier on `core/modules/*/views`.
- Docs are part of every task (CLAUDE.md "Documentation Rules"). No new doc may contradict CLAUDE.md.
- Constants (one place each): `crud.ExactCountLimit = 10_000`; `searchindex.DefaultPolicy = {MinTableRows: 10_000, MinAvgWidth: 4, MaxAvgWidth: 1024, MinDistinct: 100}`; advisory lock key `7311990002` (the schema lock is `7311990001`); maintainer interval 1 hour.

## Review Focus

1. **A total above the cap must never be shown as smaller than the rows that really exist.** If the planner estimate comes in below the counted lower bound (bad stats on a filtered query), the total is `limit+1`, not the estimate. *(Task 2, test `estimate below the bound is raised to it`.)*
2. **Redis cache entries written before the deploy** (`{"rows":…,"total":N}`) must keep decoding as *exact*. The new flag is named `estimated` with `omitempty`, so a missing key means exact. *(Task 2, test `pre-upgrade cache entry decodes as exact`.)*
3. **A trigram build interrupted mid-way** (crash, deploy, statement timeout) leaves an INVALID index that `IF NOT EXISTS` would skip forever, so the column would silently stay unindexed. The pass must drop and rebuild it. *(Task 5, test `rebuilds an invalid index`.)*
4. **Low-value columns** (a 3-value `status`, empty or very short codes, long free-text blobs) must not get an index, because every write pays for it. *(Task 4 policy tables, plus Task 5 asserting `status` gets none.)*
5. **The hourly pass must not flush the Redis read cache.** `db.Exec` bumps the whole database's cache generation for any DDL, so a no-op pass must issue no `Exec`: check the extension and index state with reads first. *(Task 5, test `a pass with nothing to do executes no DDL`.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `core/orm/query/select.go` (modify) | `CountUpTo`, `EstimateRows`, `matchingRows` on `SelectBuilder` |
| `core/orm/query/count_test.go` (create) | unit tests for the two new builder methods |
| `core/orm/internal/crud/service.go` (modify) | `Total` type; `FindAll`/`List` return it |
| `core/orm/internal/crud/repository.go` (modify) | `ExactCountLimit`, `countRows`, `FindAll` uses it, `pageEntry.Estimated` |
| `core/orm/internal/crud/dto.go` (modify) | `PaginatedResponse.TotalEstimated` |
| `core/orm/internal/handler/generic_handler.go` (modify) | write `total_estimated` |
| `core/orm/internal/crud/count_test.go` (create) | FindAll bounded-total tests |
| `core/orm/internal/crud/service_test.go` (modify) | mock signature |
| `core-front/packages/core-front/src/views/total-format.ts` (create) | `formatTotal` (the one display rule for totals) |
| `core-front/packages/core-front/src/api/ApiClient.ts`, `views/list-nav-store.ts`, `views/loader.tsx`, `views/renderers.tsx`, `views/relation-ops.tsx`, `apps/shell/src/lib/relation-actions.ts` (modify) | thread `totalEstimated` and render through `formatTotal` |
| `core/internal/searchindex/policy.go` (create) | `Candidate`, `ColumnStats`, `Policy`, `DefaultPolicy`, `Candidates`, `IndexName` (pure) |
| `core/internal/searchindex/ensure.go` (create) | `Ensure`, `EnsureWith`: lock, extension, stats, create/repair |
| `core/internal/searchindex/maintainer.go` (create) | `Run(ctx, db, interval)` |
| `core/internal/app/app.go`, `core/internal/devseed/handler.go` (modify) | wiring |
| `docs/adr/ADR-031-list-read-performance.md` (create), `CLAUDE.md`, `core/orm/README.md`, `core-front/CLAUDE.md` (modify) | docs |

---

### Task 1: Bounded count and row estimate on the query builder

**Files:**
- Modify: `core/orm/query/select.go` (add after `Count`, around line 297)
- Create: `core/orm/query/count_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `func (b SelectBuilder[T]) CountUpTo(ctx context.Context, ex executor.Executor, limit int) (n int64, capped bool, err error)`: when `capped` is false, `n` is exact. When `capped` is true, `n == limit+1`, a lower bound.
  - `func (b SelectBuilder[T]) EstimateRows(ctx context.Context, ex executor.Executor) (int64, error)`

- [ ] **Step 1: Write the failing tests**

Create `core/orm/query/count_test.go`:

```go
package query_test

import (
	"context"
	"testing"

	"core/orm/query"
)

// funcRow is a pgx.Row whose Scan is the test's own function.
type funcRow func(dest ...any) error

func (f funcRow) Scan(dest ...any) error { return f(dest...) }

func countRow(n int64) funcRow {
	return func(dest ...any) error { *dest[0].(*int64) = n; return nil }
}

func TestSelect_CountUpTo(t *testing.T) {
	t.Parallel()
	meta := mustMeta[order](t)
	base := query.Select[order](meta).
		Where(query.NewCondition("status = $1", "open")).
		OrderBy("created_at DESC").Limit(50).Offset(100)

	for _, tc := range []struct {
		name       string
		got        int64
		wantN      int64
		wantCapped bool
	}{
		{"under the limit is exact", 42, 42, false},
		{"exactly the limit is exact", 10, 10, false},
		{"one past the limit is capped", 11, 11, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex := &mockExecutor{row: countRow(tc.got)}
			n, capped, err := base.CountUpTo(context.Background(), ex, 10)
			if err != nil {
				t.Fatalf("CountUpTo: %v", err)
			}
			if n != tc.wantN || capped != tc.wantCapped {
				t.Errorf("got (%d, %v), want (%d, %v)", n, capped, tc.wantN, tc.wantCapped)
			}
			want := "SELECT COUNT(*) FROM (SELECT 1 FROM order WHERE status = $1 LIMIT 11) AS bounded"
			if ex.lastSQL != want {
				t.Errorf("SQL\n got: %s\nwant: %s", ex.lastSQL, want)
			}
			if len(ex.lastArgs) != 1 || ex.lastArgs[0] != "open" {
				t.Errorf("args = %v", ex.lastArgs)
			}
		})
	}
}

func TestSelect_EstimateRows(t *testing.T) {
	t.Parallel()
	meta := mustMeta[order](t)
	b := query.Select[order](meta).Where(query.NewCondition("status = $1", "open")).OrderBy("id").Limit(5)

	t.Run("reads Plan Rows from the JSON plan", func(t *testing.T) {
		ex := &mockExecutor{row: funcRow(func(dest ...any) error {
			*dest[0].(*[]byte) = []byte(`[{"Plan":{"Node Type":"Seq Scan","Plan Rows":100048.4}}]`)
			return nil
		})}
		n, err := b.EstimateRows(context.Background(), ex)
		if err != nil {
			t.Fatalf("EstimateRows: %v", err)
		}
		if n != 100048 {
			t.Errorf("n = %d, want 100048", n)
		}
		if want := "EXPLAIN (FORMAT JSON) SELECT 1 FROM order WHERE status = $1"; ex.lastSQL != want {
			t.Errorf("SQL\n got: %s\nwant: %s", ex.lastSQL, want)
		}
	})

	t.Run("an unreadable plan is an error, not zero", func(t *testing.T) {
		ex := &mockExecutor{row: funcRow(func(dest ...any) error {
			*dest[0].(*[]byte) = []byte(`[]`)
			return nil
		})}
		if _, err := b.EstimateRows(context.Background(), ex); err == nil {
			t.Fatal("want an error for an empty plan")
		}
	})
}
```

(The `order` fixture's table is `order`: `cache.toSnake` doesn't pluralize.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /home/noia/development/EERP/core && export PATH=$PATH:/usr/local/go/bin && rtk go test -timeout 60s -run 'TestSelect_CountUpTo|TestSelect_EstimateRows' ./orm/query/`
Expected: FAIL, `b.CountUpTo undefined` / `b.EstimateRows undefined`.

- [ ] **Step 3: Implement**

In `core/orm/query/select.go`, add `"encoding/json"` and `"math"` to the imports, then append after `Count`:

```go
// CountUpTo counts the matching rows like Count but stops after limit+1 of
// them: n is exact when capped is false, and limit+1 (a lower bound) when
// capped is true. Its cost is bounded by limit instead of growing with the
// table — what a paginated list's total needs (crud.Repository.FindAll pairs
// it with EstimateRows past the limit).
func (b SelectBuilder[T]) CountUpTo(ctx context.Context, ex executor.Executor, limit int) (n int64, capped bool, err error) {
	sub, args := b.matchingRows().Limit(limit + 1).ToSQL()
	if err := ex.QueryRow(ctx, "SELECT COUNT(*) FROM ("+sub+") AS bounded", args...).Scan(&n); err != nil {
		return 0, false, fmt.Errorf("select: count up to: %w", err)
	}
	return n, n > int64(limit), nil
}

// EstimateRows returns the planner's estimate of the matching rows (EXPLAIN:
// nothing is scanned). As accurate as the table's statistics — cheap at any
// size, but approximate; use it where an exact count would cost too much.
func (b SelectBuilder[T]) EstimateRows(ctx context.Context, ex executor.Executor) (int64, error) {
	sub, args := b.matchingRows().ToSQL()
	var raw []byte
	if err := ex.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+sub, args...).Scan(&raw); err != nil {
		return 0, fmt.Errorf("select: estimate rows: %w", err)
	}
	var plans []struct {
		Plan struct {
			Rows float64 `json:"Plan Rows"`
		} `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &plans); err != nil || len(plans) == 0 {
		return 0, fmt.Errorf("select: estimate rows: unreadable plan %q", raw)
	}
	return int64(math.Round(plans[0].Plan.Rows)), nil
}

// matchingRows keeps only what decides WHICH rows match (FROM, JOIN, WHERE,
// GROUP BY, HAVING), selecting a constant: no order, paging or row lock.
func (b SelectBuilder[T]) matchingRows() SelectBuilder[T] {
	b.cols = []string{"1"}
	b.orderBy = nil
	b.limit, b.offset = 0, 0
	b.lock = rowLock{}
	return b
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `rtk go test -timeout 60s ./orm/query/`
Expected: PASS (new and existing tests).

- [ ] **Step 5: Commit**

```bash
cd /home/noia/development/EERP && rtk git add core/orm/query/select.go core/orm/query/count_test.go && rtk git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit -m "feat(orm): bounded CountUpTo and planner EstimateRows on SelectBuilder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bounded totals in the generic list endpoint

**Files:**
- Modify: `core/orm/internal/crud/service.go:61` (interface), `:86` (`List`)
- Modify: `core/orm/internal/crud/repository.go:237-307` (`FindAll`, `pageEntry`)
- Modify: `core/orm/internal/crud/dto.go:36-41` (`PaginatedResponse`)
- Modify: `core/orm/internal/handler/generic_handler.go:226-241`
- Modify: `core/orm/internal/crud/service_test.go:54-59` (mock)
- Create: `core/orm/internal/crud/count_test.go`
- Docs: `CLAUDE.md` (ORM section, generic list endpoint paragraph), `core/orm/README.md` (generic list section; find it with `rtk rg -n 'page_size' core/orm/README.md`)

**Interfaces:**
- Consumes: `SelectBuilder.CountUpTo`, `SelectBuilder.EstimateRows` (Task 1).
- Produces:
  - `crud.Total{Rows int; Estimated bool}`
  - `const crud.ExactCountLimit = 10_000`
  - `(*Repository).FindAll(ctx, f) ([]map[string]any, Total, error)`, and the same for `(*Service).List`
  - `PaginatedResponse.TotalEstimated bool` with JSON key `total_estimated` (omitted when false)

- [ ] **Step 1: Write the failing tests**

Create `core/orm/internal/crud/count_test.go`. It reuses `captureExec` (embedded, so its `record`/`find`/`Query`/`Exec` apply) and `tenantMeta` from `repository_test.go` (same package `crud_test`):

```go
package crud_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"core/orm/access"
	"core/orm/internal/crud"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// countingExec answers the bounded count with count and the EXPLAIN with a
// plan estimating estimate rows; everything else behaves like captureExec.
type countingExec struct {
	captureExec
	count    int64
	estimate float64
}

func (e *countingExec) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	e.record(sql, args)
	return funcRow(func(dest ...any) error {
		switch {
		case strings.HasPrefix(sql, "EXPLAIN"):
			plan, _ := json.Marshal([]map[string]any{{"Plan": map[string]any{"Plan Rows": e.estimate}}})
			*dest[0].(*[]byte) = plan
		case strings.Contains(sql, "AS bounded"):
			*dest[0].(*int64) = e.count
		}
		return nil
	})
}

type funcRow func(dest ...any) error

func (f funcRow) Scan(dest ...any) error { return f(dest...) }

func TestRepository_FindAll_BoundedTotal(t *testing.T) {
	ctx := access.WithTenant(context.Background(), uuid.New())
	for _, tc := range []struct {
		name     string
		count    int64
		estimate float64
		want     crud.Total
		explain  bool
	}{
		{"exact under the limit, no EXPLAIN", 4_321, 0, crud.Total{Rows: 4_321}, false},
		{"estimated past the limit", crud.ExactCountLimit + 1, 100_048, crud.Total{Rows: 100_048, Estimated: true}, true},
		{"estimate below the bound is raised to it", crud.ExactCountLimit + 1, 12, crud.Total{Rows: crud.ExactCountLimit + 1, Estimated: true}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ex := &countingExec{count: tc.count, estimate: tc.estimate}
			repo := crud.NewRepository(ex, tenantMeta(t))
			_, total, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20, Matches: map[string]string{"label": "ab"}})
			if err != nil {
				t.Fatalf("FindAll: %v", err)
			}
			if total != tc.want {
				t.Errorf("total = %+v, want %+v", total, tc.want)
			}
			countSQL, _ := ex.find(t, "AS bounded")
			if !strings.Contains(countSQL, "LIMIT 10001") || !strings.Contains(countSQL, "tenant_id =") || !strings.Contains(countSQL, "ILIKE") {
				t.Errorf("bounded count must keep every filter and cap at 10001: %s", countSQL)
			}
			explained := false
			for _, q := range ex.queries {
				explained = explained || strings.HasPrefix(q, "EXPLAIN")
			}
			if explained != tc.explain {
				t.Errorf("EXPLAIN issued = %v, want %v", explained, tc.explain)
			}
		})
	}
}

func TestPaginatedResponse_TotalEstimatedOmittedWhenExact(t *testing.T) {
	for _, tc := range []struct {
		name string
		resp crud.PaginatedResponse
		want string
	}{
		{"exact", crud.PaginatedResponse{Total: 3}, `"total":3,`},
		{"estimated", crud.PaginatedResponse{Total: 100048, TotalEstimated: true}, `"total_estimated":true`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := json.Marshal(tc.resp)
			if !strings.Contains(string(b), tc.want) {
				t.Errorf("%s does not contain %s", b, tc.want)
			}
			if !tc.resp.TotalEstimated && strings.Contains(string(b), "total_estimated") {
				t.Errorf("exact total must omit total_estimated: %s", b)
			}
		})
	}
}
```

Also add the cache-compatibility test (Review Focus 2) to the same file. The cached entry type is unexported, so test through its JSON shape via an exported test hook. Add this to `core/orm/internal/crud/export_test.go` (`package crud`, the existing test-hook file; add `"encoding/json"` to its imports):

```go
// DecodePageEntry exposes FindAll's cache value decoding to tests.
func DecodePageEntry(raw []byte) (Total, error) {
	var e pageEntry
	err := json.Unmarshal(raw, &e)
	return Total{Rows: e.Total, Estimated: e.Estimated}, err
}
```

and to `count_test.go`:

```go
func TestPageEntry_PreUpgradeCacheEntryDecodesAsExact(t *testing.T) {
	got, err := crud.DecodePageEntry([]byte(`{"rows":[],"total":57}`))
	if err != nil {
		t.Fatal(err)
	}
	if got != (crud.Total{Rows: 57}) {
		t.Errorf("got %+v, want an exact 57", got)
	}
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /home/noia/development/EERP/core && rtk go test -timeout 60s ./orm/internal/crud/`
Expected: compile FAIL: `undefined: crud.Total`, `crud.ExactCountLimit`, `TotalEstimated`.

- [ ] **Step 3: Implement**

`core/orm/internal/crud/service.go`: add after `DistinctValue`:

```go
// Total is a list's row count: exact up to ExactCountLimit, beyond it the
// planner's estimate (Estimated) — see Repository.FindAll.
type Total struct {
	Rows      int
	Estimated bool
}
```

Change the interface line to `FindAll(ctx context.Context, f ListFilter) ([]map[string]any, Total, error)`, and change `List` to:

```go
func (s *Service) List(ctx context.Context, f ListFilter) ([]map[string]any, Total, error) {
	return s.repo.FindAll(ctx, f)
}
```

`core/orm/internal/crud/repository.go`: add above `FindAll`:

```go
// ExactCountLimit is how many matching rows a list's total counts exactly.
// Past it the total is the planner's estimate (Total.Estimated): an exact
// count scans every matching row, so it grows with the table (22 ms at 100k
// contacts, ~2 s at 10M) while the page itself stays a few milliseconds.
const ExactCountLimit = 10_000

// countRows is FindAll's total: exact up to ExactCountLimit, else the
// planner's estimate — never below the limit+1 rows the bounded count proved
// exist (stale statistics on a filtered query can estimate fewer).
func (r *Repository) countRows(ctx context.Context, b query.SelectBuilder[struct{}]) (Total, error) {
	n, capped, err := b.CountUpTo(ctx, r.db, ExactCountLimit)
	if err != nil || !capped {
		return Total{Rows: int(n)}, err
	}
	est, err := b.EstimateRows(ctx, r.db)
	if err != nil {
		return Total{}, err
	}
	return Total{Rows: int(max(est, n)), Estimated: true}, nil
}
```

In `FindAll`: change the signature to return `([]map[string]any, Total, error)`, replace every `return nil, 0, err` with `return nil, Total{}, err`, and replace the cache-hit, count and store lines:

```go
	if hit {
		return cached.Rows, Total{Rows: cached.Total, Estimated: cached.Estimated}, nil
	}

	total, err := r.countRows(ctx, b)
	if err != nil {
		return nil, Total{}, fmt.Errorf("crud: count %s: %w", r.meta.TableName, err)
	}
	// … rows query and scanToMaps unchanged …
	r.store(ctx, key, pageEntry{Rows: results, Total: total.Rows, Estimated: total.Estimated})
	return results, total, nil
```

`pageEntry` becomes:

```go
// pageEntry is FindAll's cached value. Estimated is omitempty so entries
// cached before it existed still decode as exact.
type pageEntry struct {
	Rows      []map[string]any `json:"rows"`
	Total     int              `json:"total"`
	Estimated bool             `json:"estimated,omitempty"`
}
```

`core/orm/internal/crud/dto.go`, in `PaginatedResponse`:

```go
type PaginatedResponse struct {
	Data  []map[string]any `json:"data"`
	Total int              `json:"total"`
	// TotalEstimated marks Total as the planner's estimate (more than
	// ExactCountLimit rows match); absent means Total is exact.
	TotalEstimated bool `json:"total_estimated,omitempty"`
	Page           int  `json:"page"`
	PageSize       int  `json:"page_size"`
}
```

`core/orm/internal/handler/generic_handler.go` `List`:

```go
	return c.JSON(http.StatusOK, crud.PaginatedResponse{
		Data:           resp,
		Total:          total.Rows,
		TotalEstimated: total.Estimated,
		Page:           f.Page,
		PageSize:       f.PageSize,
	})
```

`core/orm/internal/crud/service_test.go`: change the mock's `findAll` field type and method to return `crud.Total`, with the fallback `return nil, crud.Total{}, nil`. Then fix any test using `findAll:` closures (`rtk rg -n 'findAll:' core/orm/internal/crud/service_test.go`) to return `crud.Total{}`.

- [ ] **Step 4: Run every ORM test and the app route test**

Run: `rtk go test -timeout 120s ./orm/...`
Expected: PASS. If an existing test asserted a `COUNT(*)` SQL string from `FindAll`, it now sees `SELECT COUNT(*) FROM (SELECT 1 FROM … LIMIT 10001) AS bounded`; update that assertion to the bounded form.

Run: `CONFIG=/home/noia/development/EERP/eerp-config.json rtk go test -timeout 300s ./internal/app/...`
Expected: PASS. Compile errors elsewhere name every caller of the changed signature; fix them the same way.

- [ ] **Step 5: Docs**

In `CLAUDE.md`, in the paragraph starting "The generic list endpoint (`GET /api/v1/{table}`) accepts…", append this sentence: "The envelope's `total` is exact up to 10 000 matching rows (`crud.ExactCountLimit`); beyond it, it is the planner's estimate and the envelope adds `total_estimated: true`. Exact counting scans every matching row, so its cost grows with the table, while the planner's estimate is free. Pitfall: never treat an estimated total as a loop bound (page until an empty page instead) (ADR-031)."

In `core/orm/README.md`'s generic list section, document `total` / `total_estimated` the same way, plus `SelectBuilder.CountUpTo` / `EstimateRows` with a short usage example taken from `countRows`.

- [ ] **Step 6: Commit**

```bash
cd /home/noia/development/EERP && rtk git add core/orm CLAUDE.md && rtk git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit -m "perf(orm): bound list totals to 10k exact rows, planner estimate beyond

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend shows estimated totals as estimates

**Files:**
- Create: `core-front/packages/core-front/src/views/total-format.ts`, `total-format.test.ts`
- Modify: `core-front/packages/core-front/src/api/ApiClient.ts:341` (interface), `:373-395` (`listWithTotal`)
- Modify: `core-front/packages/core-front/src/views/relation-ops.tsx:41` (`listPage` type)
- Modify: `core-front/apps/shell/src/lib/relation-actions.ts:23-28` (return type)
- Modify: `core-front/packages/core-front/src/views/list-nav-store.ts:9-18` (`ListNav`)
- Modify: `core-front/packages/core-front/src/views/loader.tsx` (`total` → plus `totalEstimated`; dashboard `count` → plus `countEstimated`)
- Modify: `core-front/packages/core-front/src/views/renderers.tsx` (FormListNav ~L262-338, TreeRenderer ~L884-949 + DataGrid ~L1120, dashboard tile ~L1260-1270, `recordTotal` prop ~L108)
- Test: `core-front/packages/core-front/src/api/ApiClient.test.ts`, `views/renderers.test.tsx`

**Interfaces:**
- Consumes: the `total_estimated` envelope key (Task 2).
- Produces: `formatTotal(total: number, estimated?: boolean): string`. `listWithTotal` resolves `{ records, total, totalEstimated?: true }`; the key is absent when the total is exact, so existing `toEqual` assertions keep passing. `ListNav.totalEstimated?: boolean`.

- [ ] **Step 1: Write the failing tests**

`core-front/packages/core-front/src/views/total-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatTotal } from './total-format'

describe('formatTotal', () => {
  it.each([
    [42, undefined, '42'],
    [42, false, '42'],
    [100048, true, '≈ 100048'],
  ])('formatTotal(%s, %s) = %s', (total, estimated, want) => {
    expect(formatTotal(total, estimated)).toBe(want)
  })
})
```

In `api/ApiClient.test.ts`, next to `'listWithTotal surfaces the paginated envelope\'s total row count'`:

```ts
  it('listWithTotal flags a planner-estimated total', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, { data: [{ id: '1' }], total: 100048, total_estimated: true, page: 1, page_size: 20 }),
      ),
    )
    await expect(createServerApiClient().listWithTotal('crm')).resolves.toEqual({
      records: [{ id: '1' }],
      total: 100048,
      totalEstimated: true,
    })
  })
```

In `views/renderers.test.tsx`, inside the same `describe` as `'shows position/total and steps to the next record after browsing a filtered list'` (reuse its `formDescriptor`, `noopActions`):

```tsx
    it('marks an estimated total in the record navigator', () => {
      useListNavStore.getState().setNav(formDescriptor.entity, {
        ids: ['1', '2'], offset: 0, total: 100048, totalEstimated: true,
      })
      render(<EntityView descriptor={formDescriptor} initialData={[{ id: '1', name: 'Ada' }]} actions={noopActions} />)
      expect(screen.getByText('1 / ≈ 100048')).toBeInTheDocument()
    })
```

(Import `useListNavStore` from `./list-nav-store` if the test file does not already.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /home/noia/development/EERP/core-front/packages/core-front && npx -y pnpm@12.4.2 vitest run src/views/total-format.test.ts src/api/ApiClient.test.ts src/views/renderers.test.tsx`
Expected: FAIL (`./total-format` missing; `totalEstimated` absent; text `1 / ≈ 100048` not found).

- [ ] **Step 3: Implement**

`views/total-format.ts`:

```ts
/**
 * The one display rule for a list total. Go counts exactly up to 10 000
 * matching rows and estimates beyond (`total_estimated`, ADR-031); an
 * estimate is shown with "≈" so it never reads as an exact count.
 */
export function formatTotal(total: number, estimated?: boolean): string {
  return estimated ? `≈ ${total}` : String(total)
}
```

`api/ApiClient.ts`: change the interface to `listWithTotal<T>(entity: string, options?: EntityListOptions): Promise<{ records: T[]; total: number; totalEstimated?: true }>`. In the implementation, make the envelope type `{ data?: unknown; total?: unknown; total_estimated?: unknown } | null` and end with:

```ts
    const total = typeof envelope?.total === 'number' ? envelope.total : records.length
    return envelope?.total_estimated === true ? { records, total, totalEstimated: true } : { records, total }
```

`views/relation-ops.tsx:41`: change `listPage?` to return `Promise<{ records: RelationRecord[]; total: number; totalEstimated?: true }>`. `apps/shell/src/lib/relation-actions.ts`: change `listRecordsPage`'s return type in the same way: `Promise<{ records: RelationRecord[]; total: number; totalEstimated?: true } | ActionError>`.

`views/list-nav-store.ts`, in `ListNav` after `total`:

```ts
  /** Set when `total` is Go's planner estimate (> 10 000 matching rows, ADR-031). */
  totalEstimated?: boolean
```

`views/loader.tsx`:
- Add `totalEstimated?: boolean` after `total?: number` in the load result (doc it as "set when `total` is an estimate").
- In `loadView`: `const { records, total, totalEstimated } = await api.listWithTotal<T>(…)`, then `return { initialData: records, error: null, total, totalEstimated }`.
- In `loadDashboardWidgets`: `const { total, totalEstimated } = await api.listWithTotal(view.entity, { pageSize: 1 })`, then `return { id: view.href, title: view.title, href: view.href, count: total, countEstimated: totalEstimated === true }`.
- Where `loadView`'s result is rendered (`recordTotal={total}`, around line 230): destructure `totalEstimated` too and pass `recordTotalEstimated={totalEstimated}`.

`views/renderers.tsx`:
- `import { formatTotal } from './total-format'`.
- Next to the `recordTotal?: number` prop (~L108), add the prop `recordTotalEstimated?: boolean` with the doc "`recordTotal` is Go's estimate". Destructure it wherever `recordTotal` is destructured.
- TreeRenderer (~L884): add `const [totalEstimated, setTotalEstimated] = useState(recordTotalEstimated === true)`. In the page effect's reset branch, call `setTotalEstimated(recordTotalEstimated === true)` beside `setTotal(...)`. In `.then`, call `setTotalEstimated(res.totalEstimated === true)` beside `setTotal(res.total)`.
- The list-nav `setNav` effect (~L946): use `{ ids, offset: …, total, totalEstimated, paging: … }` and add `totalEstimated` to its dependency array.
- DataGrid (~L1123): add the prop
  ```tsx
            localeText={
              serverPaged && totalEstimated
                ? { paginationDisplayedRows: ({ from, to, count }) => `${from}–${to} of ${formatTotal(count, true)}` }
                : undefined
            }
  ```
- FormListNav: in the first-load `.then((res): ListNav => ({ … total: res.total, totalEstimated: res.totalEstimated, … }))`; in `goTo`, use `setNav(entity, { ...nav, ids, offset: …, total: res.total, totalEstimated: res.totalEstimated })`; render `{position + 1} / {formatTotal(nav.total, nav.totalEstimated)}`.
- Dashboard tile (~L1269): `{typeof count === 'number' ? formatTotal(count, widget.countEstimated === true) : '—'}`.

- [ ] **Step 4: Run tests, typecheck and lint**

Run (from `core-front/packages/core-front`): `npx -y pnpm@12.4.2 vitest run`, then `npx -y pnpm@12.4.2 build`.
Run (from `core-front`): `rtk tsc -p apps/shell` (or the repo's typecheck script: `rtk rg -n '"typecheck"|"lint"' package.json apps/shell/package.json`) and the lint script.
Expected: all PASS.

- [ ] **Step 5: Docs**

In `core-front/CLAUDE.md`, where the `ApiClient`/list data flow is described (`rtk rg -n 'listWithTotal|total' core-front/CLAUDE.md`), add: "A list total over 10 000 rows is Go's estimate (`total_estimated`, surfaced as `totalEstimated`); render every total through `formatTotal` (`views/total-format.ts`), never raw (ADR-031)."

- [ ] **Step 6: Commit**

```bash
cd /home/noia/development/EERP && rtk git add core-front && rtk git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit -m "feat(front): show planner-estimated list totals as estimates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Search index policy (pure: candidates, compliance, naming)

**Files:**
- Create: `core/internal/searchindex/policy.go`
- Create: `core/internal/searchindex/policy_test.go`

**Interfaces:**
- Consumes: `orm.ExposedTableNames() []string`, `orm.MigrationFieldsForTable(string) ([]orm.MigrationField, bool)` (existing, `core/orm/migrate.go`).
- Produces:
  - `type Candidate struct{ Table, Column string }`
  - `type ColumnStats struct{ TableRows float64; AvgWidth int; NDistinct float64 }`
  - `type Policy struct{ MinTableRows float64; MinAvgWidth, MaxAvgWidth int; MinDistinct float64 }`
  - `var DefaultPolicy Policy`
  - `func (p Policy) Eligible(s ColumnStats) bool`
  - `func Candidates() []Candidate`
  - `func IndexName(c Candidate) string`

- [ ] **Step 1: Write the failing tests**

`core/internal/searchindex/policy_test.go`:

```go
package searchindex_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"core/internal/searchindex"
	"core/orm"

	"github.com/google/uuid"
)

func TestPolicy_Eligible(t *testing.T) {
	p := searchindex.DefaultPolicy
	ok := searchindex.ColumnStats{TableRows: 100_000, AvgWidth: 14, NDistinct: -0.9}
	for _, tc := range []struct {
		name string
		mod  func(s *searchindex.ColumnStats)
		want bool
	}{
		{"names on a large table", func(*searchindex.ColumnStats) {}, true},
		{"small table: a seq scan is already cheap", func(s *searchindex.ColumnStats) { s.TableRows = 9_999 }, false},
		{"never analyzed (reltuples -1)", func(s *searchindex.ColumnStats) { s.TableRows = -1 }, false},
		{"values too short for trigrams", func(s *searchindex.ColumnStats) { s.AvgWidth = 3 }, false},
		{"long free text", func(s *searchindex.ColumnStats) { s.AvgWidth = 1025 }, false},
		{"enum-like status (absolute n_distinct)", func(s *searchindex.ColumnStats) { s.NDistinct = 3 }, false},
		{"enum-like status (fraction of rows)", func(s *searchindex.ColumnStats) { s.NDistinct = -0.0005 }, false},
		{"100 distinct values is enough", func(s *searchindex.ColumnStats) { s.NDistinct = 100 }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := ok
			tc.mod(&s)
			if got := p.Eligible(s); got != tc.want {
				t.Errorf("Eligible(%+v) = %v, want %v", s, got, tc.want)
			}
		})
	}
}

type probeText struct {
	ID       uuid.UUID      `db:"id,pk"`
	TenantID uuid.UUID      `db:"tenant_id"`
	Name     string         `db:"name"`
	Note     *string        `db:"note"`
	Amount   float64        `db:"amount"`
	Lines    map[string]any `db:"lines"`
	At       time.Time      `db:"at"`
}

type probeHidden struct {
	ID   uuid.UUID `db:"id,pk"`
	Name string    `db:"name"`
}

func TestCandidates_TextColumnsOfExposedTablesOnly(t *testing.T) {
	exposed := fmt.Sprintf("si_probe_text_%d", time.Now().UnixNano())
	hidden := exposed + "_hidden"
	if err := orm.Register[probeText](orm.WithTableName(exposed)); err != nil {
		t.Fatal(err)
	}
	if err := orm.Register[probeHidden](orm.WithTableName(hidden), orm.WithExcluded()); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range searchindex.Candidates() {
		if c.Table == exposed || c.Table == hidden {
			got = append(got, c.Table+"."+c.Column)
		}
	}
	want := []string{exposed + ".name", exposed + ".note"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("candidates = %v, want %v (uuid/number/jsonb/time columns and excluded tables never qualify)", got, want)
	}
}

func TestIndexName(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    searchindex.Candidate
		want string
	}{
		{"short names read naturally", searchindex.Candidate{Table: "contact", Column: "name"}, "idx_contact_name_trgm"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := searchindex.IndexName(tc.c); got != tc.want {
				t.Errorf("IndexName = %q, want %q", got, tc.want)
			}
		})
	}
	t.Run("long names fit Postgres's 63-byte identifier limit and stay distinct", func(t *testing.T) {
		long := strings.Repeat("t", 40)
		a := searchindex.IndexName(searchindex.Candidate{Table: long, Column: strings.Repeat("c", 30) + "_a"})
		b := searchindex.IndexName(searchindex.Candidate{Table: long, Column: strings.Repeat("c", 30) + "_b"})
		if len(a) > 63 || len(b) > 63 || a == b {
			t.Errorf("a=%q (%d) b=%q (%d)", a, len(a), b, len(b))
		}
	})
}
```

Candidate order follows the struct's field order, because `MigrationFieldsForTable` keeps `StructMeta.Fields` order, and table order follows the registry's map. The test therefore filters to its own table and compares the column order only.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd /home/noia/development/EERP/core && rtk go test -timeout 60s ./internal/searchindex/`
Expected: FAIL, package `core/internal/searchindex` does not exist.

- [ ] **Step 3: Implement**

`core/internal/searchindex/policy.go`:

```go
// Package searchindex gives every searchable text column of the generic CRUD
// surface a trigram index — automatically, from the ORM registry and
// Postgres's own statistics, so no module ever writes one by hand (ADR-031).
//
// The list endpoint's search[<col>] filter is `col::text ILIKE '%v%'`, which
// no btree can serve: without a gin_trgm_ops index it scans the whole table
// twice per request (count + page). A column gets an index when it is a TEXT
// column of an exposed table (Candidates) AND its statistics say an index
// pays for its write cost (Policy.Eligible).
package searchindex

import (
	"crypto/sha256"
	"encoding/hex"

	"core/orm"
)

// Candidate is a column that could carry a trigram index.
type Candidate struct {
	Table  string
	Column string
}

// ColumnStats is what Postgres's planner statistics say about a column.
type ColumnStats struct {
	TableRows float64 // pg_class.reltuples; -1 = never analyzed
	AvgWidth  int     // pg_stats.avg_width, bytes per non-null value
	NDistinct float64 // pg_stats.n_distinct; negative = fraction of rows
}

// Policy decides from statistics whether a candidate column's index pays for
// itself: every index slows every write of its table, so a column qualifies
// only when a search on it would otherwise be expensive AND useful.
type Policy struct {
	// MinTableRows: below it, a seq scan is ~1 ms and the index is pure cost.
	MinTableRows float64
	// MinAvgWidth: shorter values (codes, empty strings) hold no trigrams worth
	// indexing (avg_width counts a 1-byte header, so 4 ≈ 3 characters).
	MinAvgWidth int
	// MaxAvgWidth: longer free text makes the index huge; full-text search is
	// the right tool there, not trigrams.
	MaxAvgWidth int
	// MinDistinct: fewer distinct values means an enum-like column (status,
	// type) that users filter with in[], not search[].
	MinDistinct float64
}

// DefaultPolicy is the policy the maintainer applies.
var DefaultPolicy = Policy{MinTableRows: 10_000, MinAvgWidth: 4, MaxAvgWidth: 1024, MinDistinct: 100}

// Eligible reports whether a column with these statistics gets an index.
func (p Policy) Eligible(s ColumnStats) bool {
	distinct := s.NDistinct
	if distinct < 0 {
		distinct = -distinct * s.TableRows
	}
	return s.TableRows >= p.MinTableRows &&
		s.AvgWidth >= p.MinAvgWidth && s.AvgWidth <= p.MaxAvgWidth &&
		distinct >= p.MinDistinct
}

// Candidates lists every TEXT column (string, *string, untyped extension and
// WASM columns) of every table on the generic CRUD surface — the columns
// search[] can target. Excluded tables have no search[] to serve.
func Candidates() []Candidate {
	var out []Candidate
	for _, table := range orm.ExposedTableNames() {
		fields, ok := orm.MigrationFieldsForTable(table)
		if !ok {
			continue
		}
		for _, f := range fields {
			if f.SQLType == "TEXT" && !f.IsPK && !f.SoftDel {
				out = append(out, Candidate{Table: table, Column: f.Column})
			}
		}
	}
	return out
}

// maxIdentifier is Postgres's identifier length (NAMEDATALEN-1): longer names
// are silently truncated, which would make two columns' indexes collide.
const maxIdentifier = 63

// IndexName is the deterministic name of c's trigram index:
// idx_<table>_<column>_trgm, or a hash of both when that exceeds 63 bytes.
func IndexName(c Candidate) string {
	name := "idx_" + c.Table + "_" + c.Column + "_trgm"
	if len(name) <= maxIdentifier {
		return name
	}
	sum := sha256.Sum256([]byte(c.Table + "." + c.Column))
	return "idx_" + hex.EncodeToString(sum[:8]) + "_trgm"
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `rtk go test -timeout 60s ./internal/searchindex/` and `rtk go vet ./internal/searchindex/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/noia/development/EERP && rtk git add core/internal/searchindex && rtk git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit -m "feat(searchindex): trigram index policy from ORM metadata and column stats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Ensure: create and repair trigram indexes against the database

**Files:**
- Create: `core/internal/searchindex/ensure.go`
- Create: `core/internal/searchindex/ensure_test.go`

**Interfaces:**
- Consumes: `Candidate`, `ColumnStats`, `Policy`, `DefaultPolicy`, `Candidates`, `IndexName` (Task 4); `*orm.DB` (`Exec`, `Query`, `QueryRow`, `Pool()`); `testdb.Open`, `testdb.Migrate` (`core/internal/testdb`).
- Produces:
  - `func Ensure(ctx context.Context, db *orm.DB) ([]string, error)`: `EnsureWith(ctx, db, DefaultPolicy)`.
  - `func EnsureWith(ctx context.Context, db *orm.DB, p Policy) (created []string, err error)`: returns the names of the indexes it built or rebuilt. The error joins per-column failures; one bad column never stops the others.

- [ ] **Step 1: Write the failing integration test**

`core/internal/searchindex/ensure_test.go`:

```go
package searchindex_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"core/internal/searchindex"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

type probeRow struct {
	ID        uuid.UUID `db:"id,pk"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
	Label     string    `db:"label"`  // md5 per row: wide, high-cardinality → indexed
	Status    string    `db:"status"` // 3 values → enum-like, never indexed
}

// setupProbe creates a fresh, uniquely named 12 000-row table (above
// DefaultPolicy.MinTableRows) and drops only it at the end — the test may run
// against the live dev database.
func setupProbe(t *testing.T) (*orm.DB, string) {
	t.Helper()
	app := testdb.Open(t)
	table := fmt.Sprintf("si_probe_%d", time.Now().UnixNano())
	if err := orm.Register[probeRow](orm.WithTableName(table)); err != nil {
		t.Fatal(err)
	}
	testdb.Migrate(t, app, table)
	ctx := context.Background()
	t.Cleanup(func() { _, _ = app.DB.Exec(context.Background(), "DROP TABLE IF EXISTS "+table) })
	if _, err := app.DB.Exec(ctx, `INSERT INTO `+table+` (id, created_at, updated_at, label, status)
		SELECT gen_random_uuid(), now(), now(), md5(i::text), (ARRAY['open','won','lost'])[1 + i % 3]
		FROM generate_series(1, 12000) AS i`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, "ANALYZE "+table); err != nil {
		t.Fatal(err)
	}
	return app.DB, table
}

func indexValid(t *testing.T, db *orm.DB, name string) (exists, valid bool) {
	t.Helper()
	err := db.QueryRow(context.Background(),
		`SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
		 WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`, name).Scan(&valid)
	return err == nil, valid
}

func TestEnsure(t *testing.T) {
	db, table := setupProbe(t)
	ctx := context.Background()
	label := searchindex.IndexName(searchindex.Candidate{Table: table, Column: "label"})
	status := searchindex.IndexName(searchindex.Candidate{Table: table, Column: "status"})

	t.Run("indexes the compliant column only", func(t *testing.T) {
		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if !slices.Contains(created, label) {
			t.Errorf("created %v, want it to contain %s", created, label)
		}
		if exists, valid := indexValid(t, db, label); !exists || !valid {
			t.Errorf("%s exists=%v valid=%v", label, exists, valid)
		}
		if exists, _ := indexValid(t, db, status); exists {
			t.Errorf("enum-like status must not be indexed")
		}
	})

	t.Run("the list search SQL uses it", func(t *testing.T) {
		rows, err := db.Query(ctx, "EXPLAIN SELECT id FROM "+table+" WHERE label::text ILIKE '%' || $1 || '%'", "abcd")
		if err != nil {
			t.Fatal(err)
		}
		var plan strings.Builder
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			plan.WriteString(line + "\n")
		}
		rows.Close()
		if !strings.Contains(plan.String(), label) {
			t.Errorf("plan does not use %s:\n%s", label, plan.String())
		}
	})

	t.Run("a pass with nothing to do executes no DDL", func(t *testing.T) {
		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if len(created) != 0 {
			t.Errorf("second pass created %v, want nothing", created)
		}
	})

	t.Run("rebuilds an invalid index", func(t *testing.T) {
		if _, err := db.Exec(ctx, "DROP INDEX "+label); err != nil {
			t.Fatal(err)
		}
		// A failed concurrent build leaves an INVALID index under the name:
		// the shape an interrupted build has.
		if _, err := db.Exec(ctx, "CREATE UNIQUE INDEX CONCURRENTLY "+label+" ON "+table+" (status)"); err == nil {
			t.Fatal("setup: the unique build over duplicates should fail")
		}
		if exists, valid := indexValid(t, db, label); !exists || valid {
			t.Fatalf("setup: want an invalid %s, got exists=%v valid=%v", label, exists, valid)
		}
		created, err := searchindex.Ensure(ctx, db)
		if err != nil {
			t.Fatalf("Ensure: %v", err)
		}
		if !slices.Contains(created, label) {
			t.Errorf("created %v, want the rebuilt %s", created, label)
		}
		if _, valid := indexValid(t, db, label); !valid {
			t.Errorf("%s still invalid", label)
		}
	})
}
```

"Executes no DDL" is observable as "creates nothing". The implementation guarantees it structurally: every `Exec` in `ensure.go` is guarded by a read that found work to do (Step 3), and the reviewer checks this.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd /home/noia/development/EERP/core && CONFIG=/home/noia/development/EERP/eerp-config.json rtk go test -timeout 180s -run TestEnsure ./internal/searchindex/`
Expected: FAIL, `undefined: searchindex.Ensure`.

- [ ] **Step 3: Implement**

`core/internal/searchindex/ensure.go`:

```go
package searchindex

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/jackc/pgx/v5"
)

// lockKey serializes passes across processes (several core-back replicas,
// dev seeding during a maintainer tick). Distinct from internal/module's
// schema lock (7311990001): a long index build must not hold up a boot.
const lockKey int64 = 7311990002

// Ensure applies DefaultPolicy. See EnsureWith.
func Ensure(ctx context.Context, db *orm.DB) ([]string, error) {
	return EnsureWith(ctx, db, DefaultPolicy)
}

// EnsureWith gives every Candidate whose statistics pass p a trigram index,
// built CONCURRENTLY (writes keep flowing), and rebuilds one an interrupted
// build left INVALID. Indexes are never dropped for a column that stops
// qualifying: a stable schema beats a flapping one. It returns the indexes it
// built; per-column failures are joined into err and never stop the others.
//
// A pass with nothing to do issues reads only: db.Exec bumps the whole
// database's read-cache generation (core/orm/qcache) on any DDL.
func EnsureWith(ctx context.Context, db *orm.DB, p Policy) (created []string, err error) {
	conn, err := db.Pool().Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("searchindex: acquire lock connection: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return nil, fmt.Errorf("searchindex: lock: %w", err)
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", lockKey) }()

	candidates := Candidates()
	if len(candidates) == 0 {
		return nil, nil
	}
	stats, err := loadStats(ctx, db, candidates)
	if err != nil {
		return nil, err
	}
	var errs []error
	for _, c := range candidates {
		s, ok := stats[c]
		if !ok || !p.Eligible(s) {
			continue
		}
		built, err := ensureIndex(ctx, db, c)
		if err != nil {
			errs = append(errs, err)
		}
		if built {
			created = append(created, IndexName(c))
		}
	}
	return created, errors.Join(errs...)
}

// loadStats reads every candidate table's planner statistics in one query.
// A column absent from pg_stats (table never analyzed, or a column added
// since) is simply not eligible yet — autovacuum's next ANALYZE fixes that.
func loadStats(ctx context.Context, db *orm.DB, candidates []Candidate) (map[Candidate]ColumnStats, error) {
	tables := make([]string, 0, len(candidates))
	seen := map[string]bool{}
	for _, c := range candidates {
		if !seen[c.Table] {
			seen[c.Table] = true
			tables = append(tables, c.Table)
		}
	}
	rows, err := db.Query(ctx, `
		SELECT s.tablename, s.attname, c.reltuples, s.avg_width, s.n_distinct
		FROM pg_stats s
		JOIN pg_class c ON c.relname = s.tablename AND c.relnamespace = s.schemaname::regnamespace
		WHERE s.schemaname = current_schema() AND NOT s.inherited AND s.tablename = ANY($1)`, tables)
	if err != nil {
		return nil, fmt.Errorf("searchindex: read statistics: %w", err)
	}
	defer rows.Close()
	out := map[Candidate]ColumnStats{}
	for rows.Next() {
		var c Candidate
		var s ColumnStats
		if err := rows.Scan(&c.Table, &c.Column, &s.TableRows, &s.AvgWidth, &s.NDistinct); err != nil {
			return nil, fmt.Errorf("searchindex: scan statistics: %w", err)
		}
		out[c] = s
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchindex: read statistics: %w", err)
	}
	return out, nil
}
```

Then add the remaining helpers to `ensure.go` (they use the `pgx` import for `Identifier` and `ErrNoRows`):

```go
// ensureIndex builds c's index when it is missing, or drops and rebuilds it
// when an interrupted CONCURRENTLY build left it INVALID (IF NOT EXISTS
// alone would skip it forever). The pg_trgm extension is installed on first
// need only, for the same no-DDL-when-idle reason as EnsureWith.
func ensureIndex(ctx context.Context, db *orm.DB, c Candidate) (built bool, err error) {
	name := IndexName(c)
	var valid bool
	switch err := db.QueryRow(ctx, `
		SELECT i.indisvalid FROM pg_class ic JOIN pg_index i ON i.indexrelid = ic.oid
		WHERE ic.relname = $1 AND ic.relnamespace = current_schema()::regnamespace`, name).Scan(&valid); {
	case err == nil && valid:
		return false, nil
	case err == nil: // invalid
		if _, err := db.Exec(ctx, "DROP INDEX CONCURRENTLY IF EXISTS "+pgx.Identifier{name}.Sanitize()); err != nil {
			return false, fmt.Errorf("searchindex: drop invalid %s: %w", name, err)
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return false, fmt.Errorf("searchindex: inspect %s: %w", name, err)
	}
	if err := ensureTrgm(ctx, db); err != nil {
		return false, err
	}
	// #nosec G202 — identifiers come from the ORM registry, quoted anyway.
	sql := fmt.Sprintf("CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s USING gin (%s gin_trgm_ops)",
		pgx.Identifier{name}.Sanitize(), pgx.Identifier{c.Table}.Sanitize(), pgx.Identifier{c.Column}.Sanitize())
	if _, err := db.Exec(ctx, sql); err != nil {
		return false, fmt.Errorf("searchindex: create %s: %w", name, err)
	}
	return true, nil
}

// ensureTrgm installs pg_trgm when absent (read first: see EnsureWith). Needs
// a role allowed to create extensions, like internal/module's PostGIS; on a
// managed database have an admin run CREATE EXTENSION pg_trgm once.
func ensureTrgm(ctx context.Context, db *orm.DB) error {
	var present bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')`).Scan(&present); err != nil {
		return fmt.Errorf("searchindex: check pg_trgm: %w", err)
	}
	if present {
		return nil
	}
	if _, err := db.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS pg_trgm"); err != nil {
		return fmt.Errorf("searchindex: create extension pg_trgm: %w", err)
	}
	return nil
}
```

`pgx.ErrNoRows` comes through `orm.DB.QueryRow`'s logged row unchanged. If `errors.Is` fails there, check how `orm/pool/db/db.go` `loggedRow.Scan` wraps errors (`rtk rg -n 'func \(r \*loggedRow\) Scan' -A12 core/orm/pool/db/db.go`) and match on what it returns.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `CONFIG=/home/noia/development/EERP/eerp-config.json rtk go test -timeout 180s ./internal/searchindex/` and `rtk go vet ./internal/searchindex/`
Expected: PASS. Then confirm the probe table is gone: `docker exec db psql -U postgres -d poc -Atc "SELECT count(*) FROM pg_class WHERE relname LIKE 'si_probe_%' AND relkind='r'"` should print `0`.

- [ ] **Step 5: Commit**

```bash
cd /home/noia/development/EERP && rtk git add core/internal/searchindex && rtk git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit -m "feat(searchindex): build and repair trigram indexes concurrently

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the maintainer and dev seeding; ADR and docs

**Files:**
- Create: `core/internal/searchindex/maintainer.go`
- Modify: `core/internal/app/app.go` (`Run`, after the presence sweep goroutine, ~L1112)
- Modify: `core/internal/devseed/handler.go:52-74` (`Seed`)
- Create: `docs/adr/ADR-031-list-read-performance.md`
- Modify: `CLAUDE.md` (Key internal packages list: new `internal/searchindex/` bullet; `App.Run(ctx)` sentence)

**Interfaces:**
- Consumes: `searchindex.Ensure` (Task 5), `common.Logger`.
- Produces: `func Run(ctx context.Context, db *orm.DB, interval time.Duration)`.

- [ ] **Step 1: Implement the maintainer**

`core/internal/searchindex/maintainer.go`:

```go
package searchindex

import (
	"context"
	"time"

	"core/internal/common"
	"core/orm"

	"go.uber.org/zap"
)

// Run is the end of the schema workflow: a pass right after boot, then one
// every interval until ctx is done — so a table that crosses
// DefaultPolicy.MinTableRows, a newly activated module or a database
// switched to at runtime (internal/dbmanage swaps db's pool in place) gets
// its indexes without a restart. Started by App.Run.
func Run(ctx context.Context, db *orm.DB, interval time.Duration) {
	pass := func() {
		created, err := Ensure(ctx, db)
		if len(created) > 0 {
			common.Logger.Info("searchindex: built trigram indexes", zap.Strings("indexes", created))
		}
		if err != nil && ctx.Err() == nil {
			common.Logger.Warn("searchindex: pass", zap.Error(err))
		}
	}
	pass()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pass()
		}
	}
}
```

Check how other packages reference the zap logger (`rtk rg -n 'common.Logger\.' core/internal/presence/*.go | head -2`) and match it. If `common.Logger` is a `*zap.Logger`, the code above is correct as written.

- [ ] **Step 2: Wire it into `App.Run`**

In `core/internal/app/app.go`, after the presence sweep goroutine, add:

```go
	// Search index maintainer (internal/searchindex, ADR-031): the last step
	// of the schema workflow — trigram indexes for every searchable text
	// column the statistics say is worth one, built CONCURRENTLY right after
	// boot and re-checked hourly (tables grow, modules activate, dbmanage
	// switches databases). Off the boot path on purpose: a first build on a
	// large table can take minutes, and the server must not wait for it.
	go searchindex.Run(ctx, app.DB, time.Hour)
```

Add the import `"core/internal/searchindex"`.

- [ ] **Step 3: Call it after dev seeding**

In `core/internal/devseed/handler.go` `Seed`, after the error `switch` and before the final `return c.JSON(...)`:

```go
	// The seeded tables just crossed the search index policy's size floor
	// (seeding ANALYZEs them): index them now rather than at the next hourly
	// pass, so searching the demo volume is fast as soon as this returns.
	if _, err := searchindex.Ensure(c.Request().Context(), h.db); err != nil {
		common.Logger.Warn("devseed: search indexes", zap.Error(err))
	}
```

Add the imports `"core/internal/searchindex"`, `"core/internal/common"` and `"go.uber.org/zap"` if they are not already there. Then check that no import cycle exists: `rtk go build ./...`.

- [ ] **Step 4: Build, vet and run the affected suites**

Run (from `core/`): `rtk go build ./... && rtk go vet ./internal/searchindex/ ./internal/app/ ./internal/devseed/`
Run: `CONFIG=/home/noia/development/EERP/eerp-config.json rtk go test -timeout 600s ./internal/app/... ./internal/devseed/... ./internal/searchindex/...`
Expected: PASS.

- [ ] **Step 5: Verify on the live stack (the numbers this plan exists for)**

Rebuild and restart the backend (`docker compose up -d --build core-back` from the repo root; check the service name with `rtk rg -n '^  core-back:|^  backend:' compose.yml`), then wait for health.
Run: `docker logs backend 2>&1 | rg searchindex` should show `built trigram indexes` naming e.g. `idx_contact_name_trgm`, `idx_crm_name_trgm`.
Run: `docker exec db psql -U postgres -d poc -Atc "SELECT indexrelid::regclass FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname LIKE '%_trgm' AND i.indisvalid"`
Re-run the cold benchmarks from this plan's measurements (Go bridge IP via `docker inspect backend`, token from `POST /api/v1/auth/login` with `admin@eerp.local`/`admin`). Expected:
- `contact?search[name]=<random>`: p50 drops from ~131 ms to < 10 ms.
- `contact?page=<random>&page_size=50`: p50 drops from ~46 ms to < 15 ms, and the body has `"total_estimated":true`.
- `invoice?page=1&page_size=50` (a table under 10 000 rows): `total` exact, no `total_estimated` key.

Record the measured numbers in the ADR (Step 6). If a target is missed, stop and report the plan (`EXPLAIN (ANALYZE)`) rather than tuning blindly.

- [ ] **Step 6: ADR and CLAUDE.md**

Create `docs/adr/ADR-031-list-read-performance.md`, following the structure of `docs/adr/ADR-030-external-authentication.md` (`rtk read docs/adr/ADR-030-external-authentication.md | head -40` for its headings). Content:
- **Context:** the measurement table at the top of this plan. A REST→gRPC migration was evaluated and rejected: serialization is ≤0.4 ms of 40–130 ms requests, and a generic protobuf `Struct` measured 4× slower than the current JSON.
- **Decision:** (1) bounded totals (`ExactCountLimit`, `EstimateRows`, `total_estimated`, and `formatTotal` in the frontend); (2) automatic trigram indexes: the candidate rule, the `Policy` thresholds and why each exists, `CONCURRENTLY` plus invalid-index repair, never auto-drop, the separate advisory lock, no DDL when idle (qcache), the maintainer cadence, and the devseed hook.
- **Mermaid diagram:**
  ```mermaid
  flowchart LR
      Boot["Registry.Boot (tables, columns, btree/gist indexes)"] --> Run["App.Run"]
      Run --> M["searchindex.Run: now, then hourly"]
      Seed["POST /dev_seed"] --> E
      M --> E["Ensure"]
      E --> C["Candidates: TEXT columns of exposed tables"]
      C --> S["pg_stats + reltuples"]
      S --> P{"Policy.Eligible"}
      P -- yes --> I["CREATE INDEX CONCURRENTLY … gin_trgm_ops (rebuild if INVALID)"]
      P -- no --> X["skip"]
  ```
- **Consequences / pitfalls:**
  - A new table is indexed within an hour of crossing 10 000 rows and being analyzed by autovacuum (or immediately after dev seeding).
  - Searches shorter than 3 characters can't use trigrams and still scan, but they are bounded by `LIMIT` plus the bounded count.
  - Estimated totals can be off by the statistics' error, so page until an empty page instead of trusting the last page number.
  - Creating the extension needs privileges on a managed database.
  - Indexes are not dropped automatically.
- **Rejected:** keyset pagination, a custom JSON encoder, gRPC (with the measurements), and hand-written per-module indexes.
- **Measured result:** the numbers from Step 5.

`CLAUDE.md`:
- Add a bullet to "Key internal packages", next to `internal/geo/`: "`internal/searchindex/`: automatic trigram indexes for the generic list's `search[<col>]` (`col::text ILIKE '%v%'`, which no btree serves). Candidates are every TEXT column of an exposed table (`Candidates`); `Policy.Eligible` keeps those whose `pg_stats` say an index pays for its write cost (table ≥ 10 000 rows, average width 4–1024 bytes, ≥ 100 distinct values); `Ensure` builds them `CONCURRENTLY` (and rebuilds INVALID ones) under advisory lock 7311990002, reading only when there is nothing to do so it never flushes the Redis read cache. `searchindex.Run` runs it right after boot and hourly from `App.Run`; dev seeding calls `Ensure` directly. Never hand-write a trigram index in a module's `Migrate()`: make the column a TEXT field and let the policy decide. Pitfall: indexes are never dropped automatically; on a managed database `CREATE EXTENSION pg_trgm` needs an admin once. See [ADR-031](docs/adr/ADR-031-list-read-performance.md)."
- In the `App.Run(ctx)` sentence near the top, add "the search index maintainer" to the list of what it starts.

- [ ] **Step 7: Full suite and commit**

Run from the repo root: `make test`
Expected: every suite passes (Go with Redis, pdf-service, frontend lint, typecheck and tests).

```bash
cd /home/noia/development/EERP && rtk git add core/internal/searchindex core/internal/app/app.go core/internal/devseed/handler.go docs/adr/ADR-031-list-read-performance.md CLAUDE.md && rtk git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com commit -m "feat(searchindex): maintain trigram indexes after boot, hourly and after dev seeding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
