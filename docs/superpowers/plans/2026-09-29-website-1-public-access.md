# Public Access & Website Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anonymous visitors read an admin-published slice of data over `/api/v1/public/*`, and let visitors self-register website-only accounts whose tokens can never reach the ERP.

**Architecture:** A module declares a table's public-capable columns (`orm.WithPublicFields`); an admin publishes a subset plus a forced row filter (`app_settings` key `website.public.<table>`). The public route group reuses the generic list/get handlers and stamps an `access.PublicScope` on the context; the SAME `checkColumn`/`BuildResponse` choke points that enforce ADR-013 group gating enforce the scope. Website accounts are `users.kind = 'website'` rows whose JWTs carry `aud: ["website"]`; the shared `authenticate` function refuses the wrong audience on every route group.

**Tech Stack:** Go 1.x, Echo v5, pgx, golang-jwt v5, bcrypt; Next.js 16 BFF route handlers + Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-website-1-public-access-design.md` (ADR: `docs/adr/ADR-024-public-access-and-website-identities.md`)

## Global Constraints

- Run every command with the `rtk` prefix; search with `rg`, never `grep`.
- Go is off PATH on this machine — use the repo's usual invocation (`make run-back-tests BACKTESTPATH=./<pkg>/... ARGS="-run X"` from the repo root, which also starts the Docker DB). Frontend tests run in the node:22 container (see the dev-env memory) — `pnpm --filter shell vitest run <path>`.
- `depguard` forbids `fmt.Print*`/`log`; use `common.Logger` (zap). `fmt.Errorf` is fine (used everywhere).
- DB-backed tests: `testdb.Open(t)` / `buildApp(t)`; seed under a fresh `uuid.New()` tenant or unique emails (`uuid.NewString()+"@test.io"`), clean up only your rows.
- Commit format `<type>(scope): <description>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `dev`.
- A table not published → **404** on the public group. Non-public column in any param → **400**. Wrong-audience token → **403**.
- Public selection is stored at `company_id = uuid.Nil` (settings are always company-keyed; the Nil company is the site-wide slot).
- Website admin routes live at `/api/v1/website_admin/...` so the permission middleware derives `website_admin:<res>:<action>`.
- Permission wildcards only match `*:*:*`, `module:*:action|*`, `*:*:action` — grant `settings:website:read`/`write` explicitly.

## Review Focus

1. **Email case at signup** — `Foo@X.io` and `foo@x.io` are one address: signup normalises (trim + lower) and a unique index on `lower(email)` rejects the duplicate with 409 (test in Task 8).
2. **Forced filter column not public** — `event.published` scopes rows but isn't a published field; the scope must still apply, and a caller's own `filter[published]=false` must be a 400, never a bypass (test in Task 2 + Task 6).
3. **`?aggregate=` / `?distinct=` on public** — aggregate is refused (400); distinct only on published columns (tests in Task 3 + Task 6).
4. **Website token on non-generic groups** — presence (cookie path), reports, `/me/preferences` all go through `authenticate`; a website token gets 403 there too (test in Task 7).
5. **Selection naming a field the module no longer declares** — silently dropped from the effective set, never exposed (test in Task 4).

---

## File Structure

| File | Responsibility |
|---|---|
| `core/orm/access/public.go` (new) | `PublicScope` context value |
| `core/orm/internal/registry/registry.go` | `PublicFields` on `TableMeta`, `WithPublicFields` option |
| `core/orm/register.go` | facade: `WithPublicFields`, `PublicFields`, `PublicTables`, `TableHasColumn` |
| `core/orm/internal/crud/repository.go`, `aggregate.go`, `dto.go` | enforce scope in `checkColumn`, `BuildResponse`, forced row filter on reads |
| `core/orm/server/public.go` (new) | `MountPublic`, `PublicScopeMiddleware` |
| `core/internal/website/publish.go` (new) | `Publisher`: resolve effective scope; admin GET/PUT handlers |
| `core/internal/website/tenant.go` (new) | `ResolveTenant`, `TenantMiddleware` |
| `core/internal/website/me.go` (new) | website user's own profile |
| `core/internal/website/admin_users.go` (new) | ERP-side website-user admin |
| `core/internal/auth/*` | `Users.Kind`/`EmailVerifiedAt`, audience claim, website login/refresh/signup, role seed |
| `core/internal/middleware/jwt.go` | audience enforcement, `WebsiteJWTMiddleware` |
| `core/internal/types/config.go` | `website_tenant_id`, `public_rate_limit_per_minute` |
| `core/internal/app/app.go` | wiring |
| `core/modules/warehouse/module.go`, `core/modules/company/module.go` | first declarations |
| `core-front/apps/shell/src/lib/site-session.ts` (new), `app/api/site-auth/*` (new), `src/lib/bff.ts` | website BFF session |
| docs | CLAUDE.md, core-front/CLAUDE.md, ADR-024, spec |

---

### Task 1: Declare public fields in the registry

**Files:**
- Modify: `core/orm/internal/registry/registry.go` (TableMeta ~line 33, regOptions ~line 70, `buildFromCache` return ~line 437)
- Modify: `core/orm/register.go`
- Test: `core/orm/internal/registry/registry_test.go` (append; create if absent with `package registry`)

**Interfaces:**
- Produces: `registry.WithPublicFields(fields ...string) Option`; `TableMeta.PublicFields []string`; facade `orm.WithPublicFields(...)`, `orm.PublicFields(table string) ([]string, bool)`, `orm.PublicTables() map[string][]string`, `orm.TableHasColumn(table, col string) bool`.

- [ ] **Step 1: Write the failing test**

```go
func TestWithPublicFields_PopulatesMeta(t *testing.T) {
	type publicItem struct {
		ID    uuid.UUID `db:"id,pk"`
		Name  string    `db:"name"`
		Price float64   `db:"price"`
	}
	if err := Register[publicItem](WithPublicFields("name", "price", "picture")); err != nil {
		t.Fatal(err)
	}
	m, _ := Get("public_item")
	want := []string{"name", "price", "picture"} // picture: a pictures-service anchor, not a column — allowed on purpose
	if !slices.Equal(m.PublicFields, want) {
		t.Errorf("PublicFields = %v, want %v", m.PublicFields, want)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./orm/internal/registry/... ARGS="-run TestWithPublicFields"`
Expected: FAIL — `undefined: WithPublicFields`.

- [ ] **Step 3: Implement**

In `registry.go`:

```go
// TableMeta — add after Excluded:
	// PublicFields is the module-declared CEILING of what anonymous website
	// visitors may ever read (ADR-024). Empty = never public. An admin
	// publishes a subset at runtime; only the intersection is served.
	// Names are not validated against columns: a picture/attachment anchor
	// field (e.g. "picture") is not a column but is publishable.
	PublicFields []string

// regOptions — add:
	publicFields []string

// WithPublicFields declares the columns (and picture anchor fields) a table
// may expose on /api/v1/public. See ADR-024.
func WithPublicFields(fields ...string) Option {
	return func(o *regOptions) { o.publicFields = append(o.publicFields, fields...) }
}
```

In `buildFromCache`'s returned `TableMeta{...}` add `PublicFields: o.publicFields,`.

In `core/orm/register.go`:

```go
// WithPublicFields declares the table's public-capable fields (ADR-024).
func WithPublicFields(fields ...string) Option { return registry.WithPublicFields(fields...) }

// PublicFields returns table's declared public-capable fields; ok is false
// when the table is unknown, excluded, or declares none.
func PublicFields(table string) ([]string, bool) {
	m, ok := registry.Get(table)
	if !ok || m.Excluded || len(m.PublicFields) == 0 {
		return nil, false
	}
	return m.PublicFields, true
}

// PublicTables maps every table declaring public fields to those fields.
func PublicTables() map[string][]string {
	out := map[string][]string{}
	for _, m := range registry.All() {
		if !m.Excluded && len(m.PublicFields) > 0 {
			out[m.TableName] = m.PublicFields
		}
	}
	return out
}

// TableHasColumn reports whether table is registered and has column col.
func TableHasColumn(table, col string) bool {
	m, ok := registry.Get(table)
	return ok && m.HasField(col)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/orm/internal/registry core/orm/register.go
rtk git commit -m "feat(orm): WithPublicFields declares a table's public-capable fields"
```

---

### Task 2: Enforce a PublicScope in the CRUD layer

**Files:**
- Create: `core/orm/access/public.go`
- Modify: `core/orm/internal/crud/repository.go` (`checkColumn` ~line 95; `FindAll` ~200, `DistinctValues` ~297, `FindByID` ~362)
- Modify: `core/orm/internal/crud/aggregate.go` (~line 134)
- Modify: `core/orm/internal/crud/dto.go` (`BuildResponse` ~line 86)
- Test: `core/orm/internal/crud/repository_test.go`, `core/orm/internal/crud/dto_test.go`

**Interfaces:**
- Produces: `access.PublicScope{Columns []string; Equals map[string]string}`, `access.WithPublicScope(ctx, PublicScope) context.Context`, `access.PublicScopeFromContext(ctx) (PublicScope, bool)`, `(PublicScope).Allows(col string) bool`.

- [ ] **Step 1: Write the failing tests**

Append to `repository_test.go` (uses the existing `captureExec`, `rangeMeta`):

```go
// ── ADR-024: public scope ───────────────────────────────────────────────────

func publicCtx(cols []string, equals map[string]string) context.Context {
	return access.WithPublicScope(context.Background(), access.PublicScope{Columns: cols, Equals: equals})
}

func TestRepository_PublicScope_RejectsNonPublicColumns(t *testing.T) {
	ctx := publicCtx([]string{"id", "label"}, nil)
	tests := []struct {
		name string
		f    crud.ListFilter
	}{
		{"filter", crud.ListFilter{Equals: map[string]string{"price": "1"}}},
		{"search", crud.ListFilter{Matches: map[string]string{"price": "1"}}},
		{"in", crud.ListFilter{In: map[string][]string{"price": {"1"}}}},
		{"gt", crud.ListFilter{GT: map[string]string{"price": "1"}}},
		{"empty", crud.ListFilter{Empty: []string{"price"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ex := &captureExec{}
			_, _, err := crud.NewRepository(ex, rangeMeta(t)).FindAll(ctx, tt.f)
			if !errors.Is(err, crud.ErrUnknownColumn) {
				t.Fatalf("err = %v, want ErrUnknownColumn", err)
			}
		})
	}
	t.Run("distinct", func(t *testing.T) {
		_, err := crud.NewRepository(&captureExec{}, rangeMeta(t)).DistinctValues(ctx, "price", crud.ListFilter{})
		if !errors.Is(err, crud.ErrUnknownColumn) {
			t.Fatalf("err = %v, want ErrUnknownColumn", err)
		}
	})
}

func TestRepository_PublicScope_ForcesEqualsOnEveryRead(t *testing.T) {
	// "price" is NOT a public column, yet the forced filter must still apply —
	// Review Focus #2: a scope column needn't be published.
	ctx := publicCtx([]string{"id", "label"}, map[string]string{"price": "0"})
	ex := &captureExec{}
	repo := crud.NewRepository(ex, rangeMeta(t))
	if _, _, err := repo.FindAll(ctx, crud.ListFilter{Page: 1, PageSize: 20}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.FindByID(ctx, uuid.New()); !errors.Is(err, crud.ErrNotFound) {
		t.Fatalf("FindByID err = %v, want ErrNotFound", err)
	}
	if _, err := repo.DistinctValues(ctx, "label", crud.ListFilter{}); err != nil {
		t.Fatal(err)
	}
	for i, q := range ex.queries {
		if !strings.Contains(q, "price::text = $") {
			t.Errorf("query %d missing forced filter: %s", i, q)
		}
	}
}

func TestRepository_PublicScope_UnknownForcedColumnFailsClosed(t *testing.T) {
	ctx := publicCtx([]string{"id", "label"}, map[string]string{"nope": "x"})
	_, _, err := crud.NewRepository(&captureExec{}, rangeMeta(t)).FindAll(ctx, crud.ListFilter{})
	if !errors.Is(err, crud.ErrUnknownColumn) {
		t.Fatalf("err = %v, want ErrUnknownColumn", err)
	}
}
```

Append to `dto_test.go`:

```go
func TestBuildResponse_PublicScopeOmitsNonPublicKeys(t *testing.T) {
	meta := registry.TableMeta{Fields: []registry.FieldMeta{
		{Name: "id", Column: "id"}, {Name: "name", Column: "name"}, {Name: "cost", Column: "cost"},
	}}
	row := map[string]any{"id": "1", "name": "Chair", "cost": 12}
	ctx := access.WithPublicScope(context.Background(), access.PublicScope{Columns: []string{"id", "name"}})
	out := BuildResponse(ctx, meta, row)
	if _, ok := out["cost"]; ok || out["name"] != "Chair" || out["id"] != "1" {
		t.Errorf("out = %v, want id+name only", out)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `rtk make run-back-tests BACKTESTPATH=./orm/internal/crud/... ARGS="-run 'PublicScope'"`
Expected: FAIL — `undefined: access.WithPublicScope`.

- [ ] **Step 3: Implement**

`core/orm/access/public.go`:

```go
package access

import (
	"context"
	"slices"
)

// PublicScope is what an anonymous website visitor may read from one table
// (ADR-024): Columns is the effective whitelist (module-declared ∩
// admin-published, plus "id"), Equals a row filter forced onto every read —
// its columns need NOT be in Columns (e.g. "published"). Stamped only by the
// /api/v1/public route group; the generic CRUD layer enforces it at the same
// choke points as field-group gating.
type PublicScope struct {
	Columns []string
	Equals  map[string]string
}

// Allows reports whether col is readable under the scope.
func (s PublicScope) Allows(col string) bool { return slices.Contains(s.Columns, col) }

type publicScopeKey struct{}

func WithPublicScope(ctx context.Context, s PublicScope) context.Context {
	return context.WithValue(ctx, publicScopeKey{}, s)
}

func PublicScopeFromContext(ctx context.Context) (PublicScope, bool) {
	s, ok := ctx.Value(publicScopeKey{}).(PublicScope)
	return s, ok
}
```

In `repository.go`, extend `checkColumn` right after the existence check:

```go
	if scope, ok := access.PublicScopeFromContext(ctx); ok && !scope.Allows(col) {
		return fmt.Errorf("%w: %s.%s", ErrUnknownColumn, r.meta.TableName, col)
	}
```

Add below `tenantCondition`:

```go
// publicConditions returns the forced row filter of a public-scoped request
// (ADR-024), sorted for a deterministic SQL (the read cache keys on it). A
// forced column the table lacks fails closed — it came from admin config.
// Deliberately NOT routed through checkColumn: scope columns need not be public.
func (r *Repository) publicConditions(ctx context.Context) ([]query.Condition, error) {
	scope, ok := access.PublicScopeFromContext(ctx)
	if !ok {
		return nil, nil
	}
	cols := slices.Sorted(maps.Keys(scope.Equals))
	conds := make([]query.Condition, 0, len(cols))
	for _, col := range cols {
		if !r.meta.HasField(col) {
			return nil, fmt.Errorf("%w: %s.%s", ErrUnknownColumn, r.meta.TableName, col)
		}
		conds = append(conds, query.NewCondition(col+"::text = $1", scope.Equals[col]))
	}
	return conds, nil
}
```

(add `"maps"` and `"slices"` imports). In `FindAll`, `DistinctValues`, `FindByID` (repository.go) and `Aggregate` (aggregate.go), directly after each `tenantCondition` block insert (return shape matching the function — `nil, 0, err` in FindAll, `nil, err` elsewhere):

```go
	pubConds, err := r.publicConditions(ctx)
	if err != nil {
		return nil, err
	}
	for _, cond := range pubConds {
		b = b.Where(cond)
	}
```

In `FindByID` declare `err` appropriately (`pubConds, err := ...` is fine — no earlier `err` in scope there).

In `dto.go`'s `BuildResponse`, read the scope once and skip disallowed fields:

```go
	scope, scoped := access.PublicScopeFromContext(ctx)
	...
	for _, f := range meta.Fields {
		if scoped && !scope.Allows(f.Column) {
			continue
		}
		if len(f.Groups) > 0 && !intersects(f.Groups, callerGroups) {
```

- [ ] **Step 4: Run to verify they pass, plus the whole package**

Run: `rtk make run-back-tests BACKTESTPATH=./orm/...`
Expected: PASS (existing tests unaffected — no scope on their contexts).

- [ ] **Step 5: Commit**

```bash
rtk git add core/orm/access/public.go core/orm/internal/crud
rtk git commit -m "feat(orm): enforce a public scope in checkColumn, BuildResponse and every read"
```

---

### Task 3: Mount the public read routes

**Files:**
- Create: `core/orm/server/public.go`
- Test: `core/orm/server/public_test.go`

**Interfaces:**
- Consumes: `access.PublicScope` (Task 2), `TableMeta.PublicFields` (Task 1).
- Produces: `type PublicResolver func(ctx context.Context, table string) (access.PublicScope, bool, error)`; `server.MountPublic(g *echo.Group, handlers map[string]*handler.GenericHandler, resolve PublicResolver)`; `server.PublicScopeMiddleware(table string, resolve PublicResolver) echo.MiddlewareFunc`.

- [ ] **Step 1: Write the failing test**

```go
package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/orm/access"

	"github.com/labstack/echo/v5"
)

func TestPublicScopeMiddleware(t *testing.T) {
	published := func(_ context.Context, table string) (access.PublicScope, bool, error) {
		if table != "product" {
			return access.PublicScope{}, false, nil
		}
		return access.PublicScope{Columns: []string{"id", "name"}}, true, nil
	}
	tests := []struct {
		name, table, query string
		want               int
		wantScope          bool
	}{
		{"published table", "product", "", http.StatusOK, true},
		{"unpublished table is 404", "crm", "", http.StatusNotFound, false},
		{"aggregate refused", "product", "?aggregate=count", http.StatusBadRequest, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := echo.New()
			var sawScope bool
			e.GET("/x", func(c *echo.Context) error {
				_, sawScope = access.PublicScopeFromContext(c.Request().Context())
				return c.NoContent(http.StatusOK)
			}, PublicScopeMiddleware(tt.table, published))
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x"+tt.query, nil))
			if rec.Code != tt.want || sawScope != tt.wantScope {
				t.Errorf("code=%d scope=%v, want %d %v", rec.Code, sawScope, tt.want, tt.wantScope)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./orm/server/... ARGS="-run TestPublicScopeMiddleware"`
Expected: FAIL — `undefined: PublicScopeMiddleware`.

- [ ] **Step 3: Implement** `core/orm/server/public.go`

```go
package server

import (
	"context"
	"net/http"

	"core/orm/access"
	"core/orm/internal/handler"

	"github.com/labstack/echo/v5"
)

// PublicResolver answers, per request, what anonymous callers may read from
// table (ADR-024). ok=false means "not published" and yields a 404 — never an
// empty list, so the public surface cannot be enumerated.
type PublicResolver func(ctx context.Context, table string) (access.PublicScope, bool, error)

// MountPublic mounts read-only GET list + GET :id for every table declaring
// public fields, reusing the generic handlers. g must carry NO JWT or
// permission middleware — the scope is the only gate (see ADR-024 pitfalls).
func MountPublic(g *echo.Group, handlers map[string]*handler.GenericHandler, resolve PublicResolver) {
	for _, h := range handlers {
		meta := h.Meta()
		if meta.Excluded || len(meta.PublicFields) == 0 {
			continue
		}
		mw := PublicScopeMiddleware(meta.TableName, resolve)
		prefix := "/" + meta.RoutePrefix
		g.GET(prefix, h.List, mw)
		g.GET(prefix+"/:id", h.GetByID, mw)
	}
}

// PublicScopeMiddleware resolves table's scope and stamps it on the context.
func PublicScopeMiddleware(table string, resolve PublicResolver) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if c.QueryParam("aggregate") != "" {
				return echo.NewHTTPError(http.StatusBadRequest, "aggregate is not available on public routes")
			}
			ctx := c.Request().Context()
			scope, ok, err := resolve(ctx, table)
			if err != nil {
				return err
			}
			if !ok {
				return echo.NewHTTPError(http.StatusNotFound, "not found")
			}
			c.SetRequest(c.Request().WithContext(access.WithPublicScope(ctx, scope)))
			return next(c)
		}
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/orm/server/public.go core/orm/server/public_test.go
rtk git commit -m "feat(orm): MountPublic serves published tables read-only"
```

---

### Task 4: Publisher — effective scope and the admin settings API

**Files:**
- Create: `core/internal/website/publish.go`
- Test: `core/internal/website/publish_test.go`

**Interfaces:**
- Consumes: `orm.PublicFields`, `orm.PublicTables`, `orm.TableHasColumn` (Task 1); `access.PublicScope` (Task 2); `auth.MustIdentity`.
- Produces: `website.Selection{Fields []string; Filter map[string]string}`; `website.PublicKey(table string) string`; `website.NewPublisher(store SettingsStore, siteTenant uuid.UUID) *Publisher`; `(*Publisher).Resolve(ctx, table) (access.PublicScope, bool, error)` (matches `server.PublicResolver`); `(*Publisher).GetPublished(c)`, `(*Publisher).PutPublished(c)`; `type SettingsStore interface{ Get(ctx, tenantID, companyID uuid.UUID, key string) (string, bool, error); Set(ctx, tenantID, companyID uuid.UUID, key, value string) error }` (satisfied by `*settings.Repository`).

- [ ] **Step 1: Write the failing test**

```go
package website

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"core/orm"

	"github.com/google/uuid"
)

type memStore map[string]string

func (m memStore) Get(_ context.Context, _, _ uuid.UUID, key string) (string, bool, error) {
	v, ok := m[key]
	return v, ok, nil
}
func (m memStore) Set(_ context.Context, _, _ uuid.UUID, key, value string) error { m[key] = value; return nil }

type pubThing struct {
	ID        uuid.UUID `db:"id,pk"`
	Name      string    `db:"name"`
	Cost      float64   `db:"cost"`
	Published bool      `db:"published"`
}

func TestPublisher_Resolve(t *testing.T) {
	if err := orm.Register[pubThing](orm.WithPublicFields("name", "cost")); err != nil {
		t.Fatal(err)
	}
	sel := func(s Selection) string { b, _ := json.Marshal(s); return string(b) }
	tests := []struct {
		name      string
		stored    string
		wantOK    bool
		wantCols  []string
		wantEqual map[string]string
	}{
		{"nothing published", "", false, nil, nil},
		{"empty field list", sel(Selection{Filter: map[string]string{"published": "true"}}), false, nil, nil},
		{"subset + forced filter", sel(Selection{Fields: []string{"name"}, Filter: map[string]string{"published": "true"}}),
			true, []string{"name", "id"}, map[string]string{"published": "true"}},
		// Review Focus #5: a field the module no longer declares is dropped, never exposed.
		{"undeclared field dropped", sel(Selection{Fields: []string{"name", "published"}}), true, []string{"name", "id"}, nil},
		{"corrupt JSON degrades to unpublished", "{", false, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := memStore{}
			if tt.stored != "" {
				store[PublicKey("pub_thing")] = tt.stored
			}
			scope, ok, err := NewPublisher(store, uuid.New()).Resolve(context.Background(), "pub_thing")
			if err != nil || ok != tt.wantOK {
				t.Fatalf("ok=%v err=%v, want ok=%v", ok, err, tt.wantOK)
			}
			if ok && (!slices.Equal(scope.Columns, tt.wantCols) || len(scope.Equals) != len(tt.wantEqual)) {
				t.Errorf("scope = %+v, want cols %v equals %v", scope, tt.wantCols, tt.wantEqual)
			}
		})
	}
	t.Run("undeclared table", func(t *testing.T) {
		if _, ok, _ := NewPublisher(memStore{}, uuid.New()).Resolve(context.Background(), "nope"); ok {
			t.Error("undeclared table resolved as published")
		}
	})
}

func TestValidateSelection(t *testing.T) {
	declared := []string{"name", "cost"}
	tests := []struct {
		name    string
		sel     Selection
		wantErr bool
	}{
		{"valid", Selection{Fields: []string{"name"}, Filter: map[string]string{"published": "true"}}, false},
		{"field not declared", Selection{Fields: []string{"published"}}, true},
		{"filter column unknown", Selection{Fields: []string{"name"}, Filter: map[string]string{"nope": "1"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateSelection("pub_thing", declared, tt.sel); (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
```

(`TestValidateSelection` relies on `pub_thing` registered by the previous test; keep both in this file, in this order.)

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/website/...`
Expected: FAIL — package has no `Selection`.

- [ ] **Step 3: Implement** `core/internal/website/publish.go`

```go
// Package website holds the public-site plumbing of ADR-024: which data
// anonymous visitors may read, which tenant the site serves, and website
// (visitor) accounts.
package website

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// PublicKey is the app_settings key holding table's published selection.
func PublicKey(table string) string { return "website.public." + table }

// Selection is what an admin publishes for one table. Filter values are
// strings: they're compared as text, like ?filter[col]= (so "true" for a bool).
type Selection struct {
	Fields []string          `json:"fields"`
	Filter map[string]string `json:"filter,omitempty"`
}

// SettingsStore is satisfied by *settings.Repository.
type SettingsStore interface {
	Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error)
	Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error
}

type Publisher struct {
	store      SettingsStore
	siteTenant uuid.UUID
}

func NewPublisher(store SettingsStore, siteTenant uuid.UUID) *Publisher {
	return &Publisher{store: store, siteTenant: siteTenant}
}

// Resolve computes the effective scope for table in the site tenant:
// declared ∩ published fields, plus "id". Matches server.PublicResolver.
// ponytail: one indexed app_settings read per public request; cache in-process if it shows up in profiles.
func (p *Publisher) Resolve(ctx context.Context, table string) (access.PublicScope, bool, error) {
	declared, ok := orm.PublicFields(table)
	if !ok {
		return access.PublicScope{}, false, nil
	}
	sel, ok, err := p.load(ctx, p.siteTenant, table)
	if err != nil || !ok {
		return access.PublicScope{}, false, err
	}
	var cols []string
	for _, f := range sel.Fields {
		if slices.Contains(declared, f) && f != "id" {
			cols = append(cols, f)
		}
	}
	if len(cols) == 0 {
		return access.PublicScope{}, false, nil
	}
	return access.PublicScope{Columns: append(cols, "id"), Equals: sel.Filter}, true, nil
}

func (p *Publisher) load(ctx context.Context, tenant uuid.UUID, table string) (Selection, bool, error) {
	raw, found, err := p.store.Get(ctx, tenant, uuid.Nil, PublicKey(table))
	if err != nil {
		return Selection{}, false, fmt.Errorf("website: load selection %s: %w", table, err)
	}
	var sel Selection
	if !found || raw == "" || json.Unmarshal([]byte(raw), &sel) != nil {
		return Selection{}, false, nil // unparsable degrades to unpublished, like every settings read
	}
	return sel, true, nil
}

var errSelection = errors.New("invalid selection")

func validateSelection(table string, declared []string, sel Selection) error {
	for _, f := range sel.Fields {
		if !slices.Contains(declared, f) {
			return fmt.Errorf("%w: %s is not declared public by its module", errSelection, f)
		}
	}
	for col := range sel.Filter {
		if !orm.TableHasColumn(table, col) {
			return fmt.Errorf("%w: unknown filter column %s", errSelection, col)
		}
	}
	return nil
}

type publishedTable struct {
	Table    string            `json:"table"`
	Declared []string          `json:"declared"`
	Fields   []string          `json:"fields"`
	Filter   map[string]string `json:"filter"`
}

// GetPublished handles GET /api/v1/settings/website/public (settings:website:read).
func (p *Publisher) GetPublished(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	out := []publishedTable{}
	for table, declared := range orm.PublicTables() {
		sel, _, err := p.load(ctx, tenant, table)
		if err != nil {
			return err
		}
		out = append(out, publishedTable{Table: table, Declared: declared, Fields: sel.Fields, Filter: sel.Filter})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Table < out[j].Table })
	return c.JSON(http.StatusOK, out)
}

// PutPublished handles PUT /api/v1/settings/website/public/:table (settings:website:write).
func (p *Publisher) PutPublished(c *echo.Context) error {
	ctx := c.Request().Context()
	table := c.Param("table")
	declared, ok := orm.PublicFields(table)
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "table declares no public fields")
	}
	var sel Selection
	if err := c.Bind(&sel); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := validateSelection(table, declared, sel); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	raw, err := json.Marshal(sel)
	if err != nil {
		return err
	}
	if err := p.store.Set(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, PublicKey(table), string(raw)); err != nil {
		return fmt.Errorf("website: save selection: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/website
rtk git commit -m "feat(website): publisher resolves the effective public scope; admin publish API"
```

---

### Task 5: First declarations (warehouse, company)

**Files:**
- Modify: `core/modules/warehouse/module.go` (Product struct ~line 27; `Register` ~line 102)
- Modify: `core/modules/company/module.go:21`
- Test: `core/modules/warehouse/module_test.go` (append)

**Interfaces:**
- Produces: public-capable `product` (name, reference, unit, unit_price, description, picture), `product_variant` (product_id, name, unit_price, picture), `company` (see Step 3).

- [ ] **Step 1: Write the failing test**

```go
func TestRegister_DeclaresPublicFields(t *testing.T) {
	if err := (&warehouseModule{}).Register(); err != nil {
		t.Fatal(err)
	}
	for table, want := range map[string]string{"product": "description", "product_variant": "unit_price"} {
		fields, ok := orm.PublicFields(table)
		if !ok || !slices.Contains(fields, want) {
			t.Errorf("%s public fields = %v, want to contain %s", table, fields, want)
		}
	}
}
```

(Check the module's registration method name in `module.go` before writing — it's the function containing `orm.Register[Product]()`; adjust the call if it isn't `Register()`.)

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./modules/warehouse/... ARGS="-run TestRegister_DeclaresPublicFields"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `Product` (after `Name`):

```go
	// Description is long-form catalog copy — added for the public website's
	// product pages (ADR-024); optional, blank by default.
	Description string `db:"description" json:"description"`
```

Change the registrations:

```go
	if err := orm.Register[Product](orm.WithPublicFields(
		"name", "reference", "unit", "unit_price", "description", "picture")); err != nil {
	...
	if err := orm.Register[ProductVariant](orm.WithPublicFields(
		"product_id", "name", "unit_price", "picture")); err != nil {
```

In `core/modules/company/module.go`, open `internal/company`'s `Company` struct, and declare its name, contact and address columns — exactly the `db` names present there among: `name`, `email`, `phone`, `address_*`. Example (adjust to the real columns):

```go
	return orm.Register[company.Company](orm.WithPublicFields(
		"name", "email", "phone", "address_street", "address_zip_code", "address_city", "address_country"))
```

- [ ] **Step 4: Run to verify it passes**

Run: `rtk make run-back-tests BACKTESTPATH=./modules/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/modules/warehouse core/modules/company
rtk git commit -m "feat(warehouse,company): declare public-capable fields; product description"
```

---

### Task 6: Site tenant + wire the public group

**Files:**
- Create: `core/internal/website/tenant.go`
- Modify: `core/internal/types/config.go` (next to `AuthRateLimitPerMinute` ~line 114)
- Modify: `core/internal/app/app.go` (`mountRoutes`: settings group ~line 290; `srv.RegisterRoutes(...)` ~line 609)
- Modify: `eerp-config.example.json`, `eerp-config.docker.example.json` (add the two keys with defaults)
- Test: `core/internal/app/website_test.go` (new)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `types.Config.WebsiteTenantID string` (`website_tenant_id`), `types.Config.PublicRateLimitPerMinute int` (`public_rate_limit_per_minute`, default 300); `website.ResolveTenant(ctx, db *orm.DB, configured string) (uuid.UUID, error)`; `website.TenantMiddleware(id uuid.UUID) echo.MiddlewareFunc`; in `mountRoutes` a local `siteTenant uuid.UUID` (Nil when unresolved) used by Tasks 8–9.

- [ ] **Step 1: Write the failing integration test** `core/internal/app/website_test.go`

```go
package app

import (
	"context"
	"net/http"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/testdb"
	"core/internal/website"

	"github.com/google/uuid"
)

// buildSiteApp is buildApp with the dev tenant pinned as the website tenant
// (the live dev DB holds several test tenants, so auto-detection would refuse).
func buildSiteApp(t *testing.T) *client {
	t.Helper()
	cfg := testdb.Config(t)
	cfg.Environment = "development"
	cfg.CronLogDir = t.TempDir()
	cfg.WebsiteTenantID = auth.DevTenantID.String()
	a, err := Build(context.Background(), cfg, "", false)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	t.Cleanup(a.Close)
	c := &client{t: t, h: a.Handler(), a: a}
	code, body := c.do(http.MethodPost, "/api/v1/auth/login",
		map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword})
	if code != http.StatusOK {
		t.Fatalf("login: %d %s", code, body)
	}
	c.token, _ = decode(t, body)["access_token"].(string)
	return c
}

func TestPublicRoutes(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	store := settings.NewRepository(c.a.db.DB)

	// Seed one product and publish {name} only.
	name := "pub-" + uuid.NewString()
	code, body := c.do(http.MethodPost, "/api/v1/product", map[string]any{"name": name, "unit_price": 12.5})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create product: %d %s", code, body)
	}
	id, _ := decode(t, body)["id"].(string)
	t.Cleanup(func() { _, _ = c.a.db.DB.Exec(ctx, `DELETE FROM product WHERE id = $1`, id) })

	if code, body := c.do(http.MethodPut, "/api/v1/settings/website/public/product",
		map[string]any{"fields": []string{"name"}}); code != http.StatusNoContent {
		t.Fatalf("publish: %d %s", code, body)
	}
	t.Cleanup(func() { _ = store.Set(ctx, auth.DevTenantID, uuid.Nil, website.PublicKey("product"), "") })

	tests := []struct {
		name string
		path string
		want int
	}{
		{"published list", "/api/v1/public/product?search[name]=" + name, http.StatusOK},
		{"published record", "/api/v1/public/product/" + id, http.StatusOK},
		{"unpublished table is 404", "/api/v1/public/product_variant", http.StatusNotFound},
		{"undeclared table is 404", "/api/v1/public/crm", http.StatusNotFound},
		{"non-public filter column is 400", "/api/v1/public/product?filter[unit_price]=12.5", http.StatusBadRequest},
		{"non-public distinct is 400", "/api/v1/public/product?distinct=unit_price", http.StatusBadRequest},
		{"aggregate is 400", "/api/v1/public/product?aggregate=count", http.StatusBadRequest},
		{"publish needs a session", "/api/v1/settings/website/public", http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code, body := anon.do(http.MethodGet, tt.path, nil); code != tt.want {
				t.Errorf("status = %d, want %d: %s", code, tt.want, body)
			}
		})
	}

	t.Run("response carries only published keys", func(t *testing.T) {
		_, body := anon.do(http.MethodGet, "/api/v1/public/product/"+id, nil)
		got := decode(t, body)
		if _, leaked := got["unit_price"]; leaked || got["name"] != name {
			t.Errorf("body = %v, want id+name only", got)
		}
	})

	t.Run("forced filter hides rows", func(t *testing.T) {
		if code, _ := c.do(http.MethodPut, "/api/v1/settings/website/public/product",
			map[string]any{"fields": []string{"name"}, "filter": map[string]string{"unit_price": "999"}}); code != http.StatusNoContent {
			t.Fatal("republish failed")
		}
		if code, _ := anon.do(http.MethodGet, "/api/v1/public/product/"+id, nil); code != http.StatusNotFound {
			t.Errorf("status = %d, want 404 — row outside the forced filter", code)
		}
	})
}
```

Before writing: confirm the `App` field names used above (`c.a.db.DB`) by reading the `App` struct at the top of `internal/app/app.go`, and that `product` is the route prefix (`GET /api/v1/product` in the route table). Adjust to the real names.

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/app/... ARGS="-run TestPublicRoutes"`
Expected: FAIL — `cfg.WebsiteTenantID undefined`.

- [ ] **Step 3: Implement**

`config.go`, beside `AuthRateLimitPerMinute`:

```go
	// WebsiteTenantID pins the tenant the public website serves (ADR-024).
	// Empty = the database's single tenant; with several tenants and no
	// value the public routes are not mounted.
	WebsiteTenantID string `json:"website_tenant_id" needed:"false"`
	// PublicRateLimitPerMinute throttles /api/v1/public and /api/v1/website
	// per client IP; <= 0 means 300.
	PublicRateLimitPerMinute int `json:"public_rate_limit_per_minute" needed:"false"`
```

`core/internal/website/tenant.go`:

```go
package website

import (
	"context"
	"errors"
	"fmt"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// ErrNoSiteTenant means the site tenant is ambiguous: set website_tenant_id.
var ErrNoSiteTenant = errors.New("website: cannot resolve the site tenant — set website_tenant_id")

// ResolveTenant returns the configured tenant, else the single tenant owning
// live users. ponytail: resolved at boot; a dbmanage hot-swap to another
// database keeps the old value until restart.
func ResolveTenant(ctx context.Context, db *orm.DB, configured string) (uuid.UUID, error) {
	if configured != "" {
		id, err := uuid.Parse(configured)
		if err != nil {
			return uuid.Nil, fmt.Errorf("website: website_tenant_id: %w", err)
		}
		return id, nil
	}
	rows, err := db.Query(ctx, `SELECT DISTINCT tenant_id FROM users WHERE deleted_at IS NULL LIMIT 2`)
	if err != nil {
		return uuid.Nil, fmt.Errorf("website: resolve tenant: %w", err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return uuid.Nil, err
		}
		ids = append(ids, id)
	}
	if len(ids) != 1 {
		return uuid.Nil, ErrNoSiteTenant
	}
	return ids[0], rows.Err()
}

// TenantMiddleware stamps the site tenant for anonymous requests.
func TenantMiddleware(id uuid.UUID) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(access.WithTenant(c.Request().Context(), id)))
			return next(c)
		}
	}
}
```

`app.go` `mountRoutes`:

1. Add to the settings group block:

```go
	// Website published data (ADR-024): settings:website:read|write, route-derived.
	settingsStore := settings.NewRepository(app.DB)
	siteTenant, err := website.ResolveTenant(ctx, app.DB, configContent.WebsiteTenantID)
	if err != nil {
		common.Logger.Warn("⚠️  public website routes disabled", zap.Error(err))
	}
	publisher := website.NewPublisher(settingsStore, siteTenant)
	settingsGroup.GET("/website/public", publisher.GetPublished)
	settingsGroup.PUT("/website/public/:table", publisher.PutPublished)
```

(`mountRoutes` has no ctx parameter today: declare `ctx := context.Background()` at its top, matching how `Build` makes its own boot-time DB calls. `app` is the `*orm.App`; `app.DB` is the `*orm.DB` every repository constructor in this function already receives.)

2. Replace `srv.RegisterRoutes(ormserver.BuildHandlers(app), nil, ...)` with:

```go
	handlers := ormserver.BuildHandlers(app)
	srv.RegisterRoutes(handlers, nil, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware())

	// Public website reads (ADR-024) — no JWT, no permission middleware: the
	// published scope is the only gate. Deactivated modules stay dark here too.
	if siteTenant != uuid.Nil {
		publicGroup := srv.Echo().Group("/api/v1/public",
			ormserver.AuthRateLimiter(publicRateLimit(configContent)),
			website.TenantMiddleware(siteTenant),
			moduleRuntime.ActiveGateMiddleware())
		ormserver.MountPublic(publicGroup, handlers, publisher.Resolve)
	}
```

with a helper at the bottom of `app.go`:

```go
func publicRateLimit(cfg *types.Config) int {
	if cfg.PublicRateLimitPerMinute > 0 {
		return cfg.PublicRateLimitPerMinute
	}
	return 300
}
```

Check `ActiveGateMiddleware` resolves the table from the route path: if it parses the first segment after `/api/v1/`, it would read `public` — read its implementation and, if so, drop it from the public group and note it in the ADR as a known gap for spec 2 (don't widen scope here).

3. Add `"website_tenant_id": ""` and `"public_rate_limit_per_minute": 300` to both example configs.

- [ ] **Step 4: Run to verify it passes, plus the app suite**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/app/...`
Expected: PASS (existing `TestApp_Routes` unaffected).

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/website core/internal/types/config.go core/internal/app eerp-config.example.json eerp-config.docker.example.json
rtk git commit -m "feat(website): mount /api/v1/public for the site tenant"
```

---

### Task 7: Website users and the JWT audience

**Files:**
- Modify: `core/internal/auth/models.go` (`Users`)
- Modify: `core/internal/auth/token.go` (`IssueAccessWithTTL`, `Claims`)
- Modify: `core/internal/auth/handler.go` (`Handler`, `Login`, `Refresh`)
- Modify: `core/internal/middleware/jwt.go`
- Test: `core/internal/auth/token_test.go`, `core/internal/auth/handler_test.go`, `core/internal/middleware/jwt_test.go`

**Interfaces:**
- Produces: `auth.KindWebsite = "website"`, `auth.AudienceWebsite = "website"`, `Users.Kind string` (`db:"kind"`, "" = internal), `Users.EmailVerifiedAt *time.Time`, `(Users).IsWebsite() bool`, `(*Claims).IsWebsite() bool`, `(Handler).ForWebsite(siteTenant uuid.UUID, creator WebsiteUserCreator) *Handler` (creator used in Task 8; pass `nil` in tests here), `middleware.WebsiteJWTMiddleware(tokens) echo.MiddlewareFunc`.

- [ ] **Step 1: Write the failing tests**

`token_test.go`:

```go
func TestIssueAccess_AudienceFollowsUserKind(t *testing.T) {
	svc := NewTokenService(&types.Config{MasterPassword: "test-secret-key-32-bytes-minimum!"})
	for _, tt := range []struct {
		kind string
		want bool
	}{{"", false}, {KindWebsite, true}} {
		raw, err := svc.IssueAccess(Users{Kind: tt.kind}, nil, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		claims, err := svc.ParseAccess(raw)
		if err != nil || claims.IsWebsite() != tt.want {
			t.Errorf("kind %q: IsWebsite = %v (err %v), want %v", tt.kind, claims.IsWebsite(), err, tt.want)
		}
	}
}
```

`jwt_test.go` (reuse `newSvc`, `recordingHandler`):

```go
func TestAudienceIsEnforced(t *testing.T) {
	svc := newSvc()
	erpTok, _ := svc.IssueAccess(auth.Users{BaseModel: model.BaseModel{ID: uuid.New(), TenantID: uuid.New()}}, nil, nil, nil)
	siteTok, _ := svc.IssueAccess(auth.Users{BaseModel: model.BaseModel{ID: uuid.New(), TenantID: uuid.New()}, Kind: auth.KindWebsite}, nil, nil, nil)
	tests := []struct {
		name  string
		mw    echo.MiddlewareFunc
		token string
		want  int
	}{
		{"erp token on erp route", authmw.JWTMiddleware(svc), erpTok, http.StatusOK},
		{"website token on erp route", authmw.JWTMiddleware(svc), siteTok, http.StatusForbidden},
		{"website token on cookie route", authmw.JWTOrCookieMiddleware(svc, "eerp_access"), siteTok, http.StatusForbidden},
		{"website token on website route", authmw.WebsiteJWTMiddleware(svc), siteTok, http.StatusOK},
		{"erp token on website route", authmw.WebsiteJWTMiddleware(svc), erpTok, http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := testEcho()
			reached := false
			e.GET("/t", recordingHandler(&reached), tt.mw)
			req := httptest.NewRequest(http.MethodGet, "/t", nil)
			req.Header.Set("Authorization", "Bearer "+tt.token)
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d", rec.Code, tt.want)
			}
		})
	}
}
```

`handler_test.go` (uses the file's existing `buildHandler`, which wraps `auth.NewHandlerForTest`):

```go
func TestLogin_RefusesTheOtherKind(t *testing.T) {
	hash, _ := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	tests := []struct {
		name    string
		website bool   // handler flavour
		kind    string // stored user kind
		want    int
	}{
		{"erp login, internal user", false, "", http.StatusOK},
		{"erp login, website user", false, auth.KindWebsite, http.StatusUnauthorized},
		{"website login, website user", true, auth.KindWebsite, http.StatusOK},
		{"website login, internal user", true, "", http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			user := auth.Users{Email: "alice@example.com", PasswordHash: string(hash), Kind: tt.kind}
			user.BaseModel.ID = uuid.New()
			user.TenantID = uuid.New()
			h := buildHandler(user, nil, nil, nil)
			if tt.website {
				h = h.ForWebsite(user.TenantID, nil)
			}
			e := buildEchoForAuth()
			e.POST("/login", h.Login)
			req := httptest.NewRequest(http.MethodPost, "/login",
				strings.NewReader(`{"email":"alice@example.com","password":"secret"}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d; body = %s", rec.Code, tt.want, rec.Body.String())
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/auth/... ARGS="-run 'Audience|RefusesTheOtherKind'"` and `BACKTESTPATH=./internal/middleware/...`
Expected: FAIL — `undefined: KindWebsite`.

- [ ] **Step 3: Implement**

`models.go`, in `Users` after `MustChangePassword`:

```go
	// Kind separates ERP staff ("" — internal, the column default) from
	// self-registered website visitors ("website", ADR-024). A website user's
	// token carries aud=website and is refused by every ERP route.
	Kind string `db:"kind"`
	// EmailVerifiedAt is set once a website user confirms their address
	// (spec 4); nil = unverified. Unused for internal users.
	EmailVerifiedAt *time.Time `db:"email_verified_at"`
```

and:

```go
const KindWebsite = "website"

// IsWebsite reports whether u is a website (visitor) account.
func (u Users) IsWebsite() bool { return u.Kind == KindWebsite }
```

`token.go`:

```go
// AudienceWebsite marks a website-visitor token (ADR-024). ERP tokens carry no audience.
const AudienceWebsite = "website"

// IsWebsite reports whether the token was issued to a website user.
func (c *Claims) IsWebsite() bool { return slices.Contains(c.Audience, AudienceWebsite) }
```

In `IssueAccessWithTTL`, after building `claims`:

```go
	if user.IsWebsite() {
		claims.Audience = jwt.ClaimStrings{AudienceWebsite}
	}
```

`handler.go`: add fields and constructor variant:

```go
type Handler struct {
	users   userQuerier
	tokens  tokenIssuer
	refresh refreshStorer
	perms   permissionSource
	// website flips this handler to the visitor flavour (ADR-024): only
	// kind=website users of siteTenant may log in / refresh, and Signup works.
	website    bool
	siteTenant uuid.UUID
	creator    WebsiteUserCreator
}

// ForWebsite returns a copy serving website (visitor) accounts.
func (h Handler) ForWebsite(siteTenant uuid.UUID, creator WebsiteUserCreator) *Handler {
	h.website, h.siteTenant, h.creator = true, siteTenant, creator
	return &h
}

// kindMatches: a handler only ever authenticates its own kind of user.
func (h *Handler) kindMatches(u Users) bool {
	return u.IsWebsite() == h.website && (!h.website || u.TenantID == h.siteTenant)
}
```

Declare the Task-8 interface now so this compiles:

```go
// WebsiteUserCreator creates a website account (Task 8: *UserRepository).
type WebsiteUserCreator interface {
	CreateWebsiteUser(ctx context.Context, tenantID uuid.UUID, email, password, name string) (Users, error)
}
```

In `Login`, change `if user.DeletedAt != nil {` to `if user.DeletedAt != nil || !h.kindMatches(user) {` (after the bcrypt compare, so timing is unchanged). In `Refresh`, change `if err != nil || user.DeletedAt != nil {` to `if err != nil || user.DeletedAt != nil || !h.kindMatches(user) {`.

Extract the tail of `Login` (from `roles, err := h.users.FindRoleNames(...)` to the final `c.JSON`) into `func (h *Handler) issueSession(c *echo.Context, user Users) error` and call `return h.issueSession(c, user)` from `Login` — Signup reuses it in Task 8. Keep error-message prefixes (`"login: ..."`) as they are.

`middleware/jwt.go`: give `authenticate` a `website bool` parameter; `JWTMiddleware` and `JWTOrCookieMiddleware` pass `false`; add:

```go
// WebsiteJWTMiddleware authenticates website-visitor tokens only (ADR-024).
// ERP tokens are refused: the two sessions are deliberately independent.
func WebsiteJWTMiddleware(tokens *auth.TokenService) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			header := c.Request().Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				return unauthenticated(c)
			}
			return authenticate(c, next, tokens, strings.TrimPrefix(header, "Bearer "), true)
		}
	}
}
```

In `authenticate`, right after a successful parse:

```go
	// Audience gate (ADR-024): lives here, not in roles, so no role grant can
	// ever let a website token into the ERP — or an ERP token into the site.
	if claims.IsWebsite() != website {
		return c.JSON(http.StatusForbidden, map[string]any{"error": map[string]any{
			"code": "FORBIDDEN", "message": "This session cannot access this resource.",
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		}})
	}
```

- [ ] **Step 4: Run to verify they pass, plus both packages and the app suite**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/auth core/internal/middleware
rtk git commit -m "feat(auth): website users carry aud=website; every ERP route refuses them"
```

---

### Task 8: Website signup, roles and the unique email index

**Files:**
- Modify: `core/internal/auth/seed.go` (new `SeedWebsiteRoles`)
- Modify: `core/internal/auth/admin_repository.go` (new `CreateWebsiteUser`, `ErrEmailTaken`; `ListByTenant`/`FindInTenant` exclude website users)
- Modify: `core/internal/auth/handler.go` (new `Signup`)
- Modify: `core/modules/auth/module.go` (`Migrate`: unique index)
- Modify: `core/internal/app/app.go` (website auth group)
- Test: `core/internal/app/website_test.go` (append)

**Interfaces:**
- Consumes: `Handler.ForWebsite`, `issueSession`, `WebsiteUserCreator` (Task 7); `siteTenant`, `publicRateLimit` (Task 6).
- Produces: `auth.SeedWebsiteRoles(ctx, db *orm.DB, tenantID uuid.UUID) error`; role technical names `website_anonymous`, `website_user`, `website_admin`; `(*UserRepository).CreateWebsiteUser(...)`; `auth.ErrEmailTaken`; routes `POST /api/v1/website/auth/{signup,login,refresh,logout}`; `websiteJWT := authmw.WebsiteJWTMiddleware(tokenSvc)` local in `mountRoutes` for Task 9.

- [ ] **Step 1: Pre-check existing data**

The unique index fails the boot if the dev DB already holds two live users whose emails differ only by case. Run:

```bash
rtk docker compose exec db psql -U postgres -d poc -c \
  "SELECT lower(email), count(*) FROM users WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1"
```

Expected: 0 rows. If not, stop and report the duplicates to the user — do not delete users.

Also run `rtk rg -n 'CreateUser\(|Email: *"' core --glob '*_test.go'` and confirm every DB-backed test creating users uses a unique email per run; fix any that reuse a fixed address by suffixing `uuid.NewString()`.

- [ ] **Step 2: Write the failing test** (append to `website_test.go`)

```go
func TestWebsiteAccounts(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	email := "Visitor-" + uuid.NewString() + "@Test.io"
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))`, email)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM users WHERE lower(email) = lower($1)`, email)
	})

	code, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup",
		map[string]string{"email": email, "password": "correct horse", "name": "Vi"})
	if code != http.StatusOK {
		t.Fatalf("signup: %d %s", code, body)
	}
	site := &client{t: t, h: c.h, token: decode(t, body)["access_token"].(string)}

	tests := []struct {
		name   string
		c      *client
		method string
		path   string
		body   any
		want   int
	}{
		// Review Focus #1: same address, different case.
		{"duplicate email (case-insensitive) is 409", anon, http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": strings.ToUpper(email), "password": "correct horse", "name": "X"}, http.StatusConflict},
		{"short password is 400", anon, http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": "a" + email, "password": "short", "name": "X"}, http.StatusBadRequest},
		{"bad email is 400", anon, http.MethodPost, "/api/v1/website/auth/signup",
			map[string]string{"email": "nope", "password": "correct horse", "name": "X"}, http.StatusBadRequest},
		{"website login works", anon, http.MethodPost, "/api/v1/website/auth/login",
			map[string]string{"email": email, "password": "correct horse"}, http.StatusOK},
		{"erp login refuses a website user", anon, http.MethodPost, "/api/v1/auth/login",
			map[string]string{"email": email, "password": "correct horse"}, http.StatusUnauthorized},
		{"website login refuses the erp admin", anon, http.MethodPost, "/api/v1/website/auth/login",
			map[string]string{"email": auth.DevAdminEmail, "password": auth.DevAdminPassword}, http.StatusUnauthorized},
		// Review Focus #4: every ERP group refuses the website token.
		{"website token on generic CRUD", site, http.MethodGet, "/api/v1/crm", nil, http.StatusForbidden},
		{"website token on /me/preferences", site, http.MethodGet, "/api/v1/me/preferences", nil, http.StatusForbidden},
		{"website token on settings", site, http.MethodGet, "/api/v1/settings/tax", nil, http.StatusForbidden},
		{"website token on presence", site, http.MethodGet, "/api/v1/presence", nil, http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code, body := tt.c.do(tt.method, tt.path, tt.body); code != tt.want {
				t.Errorf("status = %d, want %d: %s", code, tt.want, body)
			}
		})
	}

	t.Run("settings users list hides website users", func(t *testing.T) {
		_, body := c.do(http.MethodGet, "/api/v1/users", nil)
		if strings.Contains(strings.ToLower(string(body)), strings.ToLower(email)) {
			t.Error("website user listed in Settings → Users")
		}
	})
}
```

(add `"strings"` to the imports.)

- [ ] **Step 3: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/app/... ARGS="-run TestWebsiteAccounts"`
Expected: FAIL — signup route 404.

- [ ] **Step 4: Implement**

`modules/auth/module.go` `Migrate`, after the `idx_user_roles_user_role` block:

```go
	// One live account per address, case-insensitively, across both kinds
	// (ADR-024: an email is either staff or a website visitor in v1). Website
	// signup normalises to lower case; this index is the race-proof guard.
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live
		ON users (lower(email))
		WHERE deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("auth: create users email index: %w", err)
	}
```

`seed.go`:

```go
// SeedWebsiteRoles idempotently seeds the three website roles (ADR-024) in
// tenantID. website_anonymous and website_user hold no ERP permission — their
// access comes only from the /public and /website route groups;
// website_admin is an ERP role for staff running the site.
func SeedWebsiteRoles(ctx context.Context, db *orm.DB, tenantID uuid.UUID) error {
	roles := orm.MustRepo[Roles](db)
	perms := orm.MustRepo[Permissions](db)
	for _, r := range []Roles{
		{BaseModel: model.BaseModel{ID: seedUUID(tenantID, "role:website_anonymous"), TenantID: tenantID}, Name: "Website visitor", Description: "Anonymous website visitor. Holds no ERP permission.", TechnicalName: ptr("website_anonymous")},
		{BaseModel: model.BaseModel{ID: WebsiteUserRoleID(tenantID), TenantID: tenantID}, Name: "Website user", Description: "Self-registered website account. Website-only access.", TechnicalName: ptr("website_user")},
		{BaseModel: model.BaseModel{ID: seedUUID(tenantID, "role:website_admin"), TenantID: tenantID}, Name: "Website admin", Description: "Manages the website: published data, pages, events, website users.", TechnicalName: ptr("website_admin")},
	} {
		if _, err := roles.Upsert(ctx, r, []string{"id"}, ""); err != nil {
			return fmt.Errorf("seed website roles: %w", err)
		}
	}
	for _, code := range []string{"settings:website:read", "settings:website:write", "website_admin:*:*"} {
		p, err := perms.UpsertPartial(ctx,
			Permissions{ID: seedUUID(tenantID, "permission:"+code), Code: code, Description: "Website admin (default)", Module: "website"},
			[]string{"code"}, "deleted_at IS NULL", "")
		if err != nil {
			return fmt.Errorf("seed website roles: permission %s: %w", code, err)
		}
		if _, err := db.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			seedUUID(tenantID, "role:website_admin"), p.ID); err != nil {
			return fmt.Errorf("seed website roles: role_permissions: %w", err)
		}
	}
	return nil
}

// WebsiteUserRoleID is the deterministic id of tenantID's website_user role.
func WebsiteUserRoleID(tenantID uuid.UUID) uuid.UUID { return seedUUID(tenantID, "role:website_user") }
```

`admin_repository.go`:

```go
// ErrEmailTaken: a live account already uses this address (any case, any kind).
var ErrEmailTaken = errors.New("email already registered")

// CreateWebsiteUser creates a kind=website user holding website_user, in one
// transaction. email must already be normalised (trimmed, lower-cased).
func (r *UserRepository) CreateWebsiteUser(ctx context.Context, tenantID uuid.UUID, email, password, name string) (Users, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return Users{}, fmt.Errorf("user: create website: %w", err)
	}
	var created Users
	err = orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		u := Users{BaseModel: model.BaseModel{TenantID: tenantID}, Email: email, PasswordHash: string(hash), Name: name, Kind: KindWebsite}
		if created, err = r.users.WithTx(tx).Create(ctx, u); err != nil {
			return err
		}
		_, err = orm.MustRepo[UserRoles](r.db).WithTx(tx).Create(ctx,
			UserRoles{BaseModel: model.BaseModel{TenantID: tenantID}, UserID: created.ID, RoleID: WebsiteUserRoleID(tenantID)})
		return err
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return Users{}, ErrEmailTaken
	}
	if err != nil {
		return Users{}, fmt.Errorf("user: create website: %w", err)
	}
	return created, nil
}
```

In `ListByTenant` and `FindInTenant`, add the condition `orm.Cond("kind <> $1", KindWebsite)` so Settings → Users never lists or edits website users.

`handler.go`:

```go
// Signup handles POST /api/v1/website/auth/signup (website flavour only).
// The "already registered" 409 does reveal that an address has an account —
// accepted for signup (standard UX); login and booking never reveal it.
func (h *Handler) Signup(c *echo.Context) error {
	if !h.website || h.creator == nil {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid email")
	}
	if len(req.Password) < 8 || len(req.Password) > 72 { // 72: bcrypt's input limit
		return echo.NewHTTPError(http.StatusBadRequest, "password must be 8 to 72 characters")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 200 {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required (max 200 characters)")
	}
	user, err := h.creator.CreateWebsiteUser(c.Request().Context(), h.siteTenant, email, req.Password, name)
	if errors.Is(err, ErrEmailTaken) {
		return echo.NewHTTPError(http.StatusConflict, "this email cannot be used")
	}
	if err != nil {
		return fmt.Errorf("signup: %w", err)
	}
	return h.issueSession(c, user)
}
```

(imports: `net/mail`, `strings`.) Also make the website `Login` look the address up normalised: at the top of `Login`, `if h.website { req.Email = strings.ToLower(strings.TrimSpace(req.Email)) }`.

`app.go`, inside the `if siteTenant != uuid.Nil {` block from Task 6 (hoist it so both public and website groups sit in it):

```go
		if err := auth.SeedWebsiteRoles(ctx, app.DB, siteTenant); err != nil {
			return fmt.Errorf("seed website roles: %w", err)
		}
		siteAuth := authHandler.ForWebsite(siteTenant, userRepo)
		websiteAuthGroup := srv.Echo().Group("/api/v1/website/auth", ormserver.AuthRateLimiter(configContent.AuthRateLimitPerMinute))
		websiteAuthGroup.POST("/signup", siteAuth.Signup)
		websiteAuthGroup.POST("/login", siteAuth.Login)
		websiteAuthGroup.POST("/refresh", siteAuth.Refresh)
		websiteAuthGroup.POST("/logout", siteAuth.Logout)
```

(`authHandler` is a `*Handler`; `ForWebsite` has a value receiver, so `authHandler.ForWebsite(...)` copies it — correct.)

- [ ] **Step 5: Run to verify it passes, plus everything**

Run: `rtk make run-back-tests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add core/internal/auth core/modules/auth core/internal/app
rtk git commit -m "feat(website): visitor signup/login, website roles, case-insensitive unique email"
```

---

### Task 9: Website profile and ERP-side website-user admin

**Files:**
- Create: `core/internal/website/me.go`, `core/internal/website/admin_users.go`
- Modify: `core/internal/auth/admin_repository.go` (three small repository methods)
- Modify: `core/internal/app/app.go`
- Test: `core/internal/app/website_test.go` (append)

**Interfaces:**
- Consumes: `websiteJWT` / `siteTenant` (Tasks 6–8), `auth.RefreshStore.RevokeAll`.
- Produces: `GET|PUT /api/v1/website/me`; `GET /api/v1/website_admin/users`, `PUT /api/v1/website_admin/users/:id` (permissions `website_admin:users:read|write`); `(*UserRepository).UpdateWebsiteProfile(ctx, tenantID, id uuid.UUID, p WebsiteProfile) error`, `ListWebsiteUsers(ctx, tenantID) ([]Users, error)` (includes disabled), `SetWebsiteUserDisabled(ctx, tenantID, id uuid.UUID, disabled bool) error`; `auth.WebsiteProfile{Name, Surname, Phone string}`.

- [ ] **Step 1: Write the failing test** (append)

```go
func TestWebsiteProfileAndAdmin(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	email := "visitor-" + uuid.NewString() + "@test.io"
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, email)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
	})
	_, body := anon.do(http.MethodPost, "/api/v1/website/auth/signup",
		map[string]string{"email": email, "password": "correct horse", "name": "Vi"})
	site := &client{t: t, h: c.h, token: decode(t, body)["access_token"].(string)}

	if code, body := site.do(http.MethodPut, "/api/v1/website/me", map[string]string{"name": "Vivi", "phone": "0102"}); code != http.StatusNoContent {
		t.Fatalf("put me: %d %s", code, body)
	}
	_, body = site.do(http.MethodGet, "/api/v1/website/me", nil)
	if me := decode(t, body); me["name"] != "Vivi" || me["email"] != email {
		t.Fatalf("me = %v", me)
	}
	if code, _ := c.do(http.MethodGet, "/api/v1/website/me", nil); code != http.StatusForbidden {
		t.Errorf("erp token on /website/me = %d, want 403", code)
	}

	// ERP admin lists and disables the visitor.
	_, body = c.do(http.MethodGet, "/api/v1/website_admin/users", nil)
	var id string
	var list []map[string]any
	_ = json.Unmarshal(body, &list)
	for _, u := range list {
		if u["email"] == email {
			id, _ = u["id"].(string)
		}
	}
	if id == "" {
		t.Fatalf("visitor not in website_admin list: %s", body)
	}
	if code, body := c.do(http.MethodPut, "/api/v1/website_admin/users/"+id, map[string]any{"disabled": true}); code != http.StatusNoContent {
		t.Fatalf("disable: %d %s", code, body)
	}
	if code, _ := anon.do(http.MethodPost, "/api/v1/website/auth/login",
		map[string]string{"email": email, "password": "correct horse"}); code != http.StatusUnauthorized {
		t.Errorf("disabled visitor login = %d, want 401", code)
	}
	if code, _ := site.do(http.MethodGet, "/api/v1/website_admin/users", nil); code != http.StatusForbidden {
		t.Errorf("website token on website_admin = %d, want 403", code)
	}
}
```

(add `"encoding/json"` import.)

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/app/... ARGS="-run TestWebsiteProfileAndAdmin"`
Expected: FAIL — 404 on `/api/v1/website/me`.

- [ ] **Step 3: Implement**

`admin_repository.go`:

```go
// WebsiteProfile is the part of a website account its owner or a website
// admin may edit. Email is not editable in v1 (it keys booking history, spec 4).
type WebsiteProfile struct {
	Name    string `json:"name"`
	Surname string `json:"surname"`
	Phone   string `json:"phone"`
}

func (r *UserRepository) UpdateWebsiteProfile(ctx context.Context, tenantID, id uuid.UUID, p WebsiteProfile) error {
	n, err := r.users.UpdateQuery().
		Set("name", p.Name).Set("surname", p.Surname).Set("phone", p.Phone).Set("updated_at", time.Now()).
		Where(orm.Cond("id = $1 AND tenant_id = $2 AND kind = $3", id, tenantID, KindWebsite)).
		Exec(ctx, r.db)
	if err != nil {
		return fmt.Errorf("user: update website profile: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("user: update website profile: %w", orm.ErrNotFound)
	}
	return nil
}

// ListWebsiteUsers returns tenantID's website accounts, disabled ones
// (soft-deleted) included — raw SQL because the typed repo hides them.
func (r *UserRepository) ListWebsiteUsers(ctx context.Context, tenantID uuid.UUID) ([]Users, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, email, name, surname, phone, created_at, deleted_at, email_verified_at
		FROM users WHERE tenant_id = $1 AND kind = $2 ORDER BY email`, tenantID, KindWebsite)
	if err != nil {
		return nil, fmt.Errorf("user: list website: %w", err)
	}
	defer rows.Close()
	var out []Users
	for rows.Next() {
		var u Users
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Surname, &u.Phone, &u.CreatedAt, &u.DeletedAt, &u.EmailVerifiedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetWebsiteUserDisabled soft-deletes (disabled) or restores a website account.
// Login and refresh already refuse a soft-deleted user; the caller also
// revokes its refresh tokens so an open session ends at the next refresh.
func (r *UserRepository) SetWebsiteUserDisabled(ctx context.Context, tenantID, id uuid.UUID, disabled bool) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE users SET deleted_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND kind = $3`, id, tenantID, KindWebsite, disabled)
	if err != nil {
		return fmt.Errorf("user: disable website: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("user: disable website: %w", orm.ErrNotFound)
	}
	return nil
}
```

(Check `r.db.Exec`'s return type — it's used as `pgconn.CommandTag` elsewhere; adjust if `orm.DB.Exec` returns something else. Restoring a user whose email was re-registered meanwhile hits the unique index → surface it as 409 in the handler via `errors.As(*pgconn.PgError)` code `23505`.)

`core/internal/website/me.go`:

```go
package website

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type meStore interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
	UpdateWebsiteProfile(ctx context.Context, tenantID, id uuid.UUID, p auth.WebsiteProfile) error
}

// MeHandler serves a website user's own profile, behind WebsiteJWTMiddleware.
type MeHandler struct{ users meStore }

func NewMeHandler(users meStore) *MeHandler { return &MeHandler{users: users} }

// Get handles GET /api/v1/website/me.
func (h *MeHandler) Get(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	u, err := h.users.FindByID(c.Request().Context(), id.UserID)
	if errors.Is(err, orm.ErrNotFound) {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{
		"email": u.Email, "name": u.Name, "surname": u.Surname, "phone": u.Phone,
		"email_verified": u.EmailVerifiedAt != nil,
	})
}

// Put handles PUT /api/v1/website/me.
func (h *MeHandler) Put(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	var p auth.WebsiteProfile
	if err := c.Bind(&p); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := validProfile(&p); err != nil {
		return err
	}
	if err := h.users.UpdateWebsiteProfile(c.Request().Context(), id.TenantID, id.UserID, p); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func validProfile(p *auth.WebsiteProfile) error {
	p.Name, p.Surname, p.Phone = strings.TrimSpace(p.Name), strings.TrimSpace(p.Surname), strings.TrimSpace(p.Phone)
	if p.Name == "" || len(p.Name) > 200 || len(p.Surname) > 200 || len(p.Phone) > 50 {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required; name/surname ≤ 200, phone ≤ 50 characters")
	}
	return nil
}
```

`core/internal/website/admin_users.go`:

```go
package website

import (
	"context"
	"errors"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/labstack/echo/v5"
)

type adminStore interface {
	ListWebsiteUsers(ctx context.Context, tenantID uuid.UUID) ([]auth.Users, error)
	SetWebsiteUserDisabled(ctx context.Context, tenantID, id uuid.UUID, disabled bool) error
	UpdateWebsiteProfile(ctx context.Context, tenantID, id uuid.UUID, p auth.WebsiteProfile) error
}

type revoker interface {
	RevokeAll(ctx context.Context, userID uuid.UUID) error
}

// AdminUsersHandler is the ERP-side management of website accounts
// (/api/v1/website_admin/users, permissions website_admin:users:*).
type AdminUsersHandler struct {
	users   adminStore
	refresh revoker
}

func NewAdminUsersHandler(users adminStore, refresh revoker) *AdminUsersHandler {
	return &AdminUsersHandler{users: users, refresh: refresh}
}

type websiteUserResponse struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	Name          string    `json:"name"`
	Surname       string    `json:"surname"`
	Phone         string    `json:"phone"`
	CreatedAt     time.Time `json:"created_at"`
	Disabled      bool      `json:"disabled"`
	EmailVerified bool      `json:"email_verified"`
}

// List handles GET /api/v1/website_admin/users.
func (h *AdminUsersHandler) List(c *echo.Context) error {
	ctx := c.Request().Context()
	users, err := h.users.ListWebsiteUsers(ctx, auth.MustIdentity(ctx).TenantID)
	if err != nil {
		return err
	}
	out := make([]websiteUserResponse, 0, len(users))
	for _, u := range users {
		out = append(out, websiteUserResponse{ID: u.ID, Email: u.Email, Name: u.Name, Surname: u.Surname, Phone: u.Phone,
			CreatedAt: u.CreatedAt, Disabled: u.DeletedAt != nil, EmailVerified: u.EmailVerifiedAt != nil})
	}
	return c.JSON(http.StatusOK, out)
}

// Update handles PUT /api/v1/website_admin/users/:id — {disabled?, name?, surname?, phone?}.
func (h *AdminUsersHandler) Update(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}
	var req struct {
		Disabled *bool `json:"disabled"`
		*auth.WebsiteProfile
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if req.Disabled != nil {
		err := h.users.SetWebsiteUserDisabled(ctx, tenant, id, *req.Disabled)
		var pgErr *pgconn.PgError
		switch {
		case errors.Is(err, orm.ErrNotFound):
			return echo.NewHTTPError(http.StatusNotFound)
		case errors.As(err, &pgErr) && pgErr.Code == "23505":
			return echo.NewHTTPError(http.StatusConflict, "another account now uses this email")
		case err != nil:
			return err
		}
		if *req.Disabled {
			if err := h.refresh.RevokeAll(ctx, id); err != nil {
				return err
			}
		}
	}
	if req.WebsiteProfile != nil {
		if err := validProfile(req.WebsiteProfile); err != nil {
			return err
		}
		if err := h.users.UpdateWebsiteProfile(ctx, tenant, id, *req.WebsiteProfile); errors.Is(err, orm.ErrNotFound) {
			return echo.NewHTTPError(http.StatusNotFound)
		} else if err != nil {
			return err
		}
	}
	return c.NoContent(http.StatusNoContent)
}
```

(Updating the profile of a disabled user 404s because `UpdateWebsiteProfile` goes through the typed repo's soft-delete filter — acceptable: re-enable first.)

`app.go`: inside the `siteTenant != uuid.Nil` block:

```go
		websiteJWT := authmw.WebsiteJWTMiddleware(tokenSvc)
		siteMe := website.NewMeHandler(userRepo)
		websiteGroup := srv.Echo().Group("/api/v1/website", ormserver.AuthRateLimiter(publicRateLimit(configContent)), websiteJWT)
		websiteGroup.GET("/me", siteMe.Get)
		websiteGroup.PUT("/me", siteMe.Put)
```

Note `/api/v1/website/auth/*` is a separate group mounted earlier without `websiteJWT` — Echo routes by full path, so the two groups don't collide; verify `POST /api/v1/website/auth/signup` still passes `TestWebsiteAccounts`.

Outside that block (ERP admin works even with no site tenant):

```go
	// Website users administration (ADR-024): website_admin:users:read|write.
	websiteAdmin := website.NewAdminUsersHandler(userRepo, refreshStore)
	websiteAdminGroup := srv.Echo().Group("/api/v1/website_admin", jwtMw, permMw)
	websiteAdminGroup.GET("/users", websiteAdmin.List)
	websiteAdminGroup.PUT("/users/:id", websiteAdmin.Update)
```

- [ ] **Step 4: Run to verify it passes, plus everything**

Run: `rtk make run-back-tests`
Expected: PASS.

- [ ] **Step 5: Lint**

Run (from `core/`): `rtk golangci-lint run ./...`
Expected: no new findings.

- [ ] **Step 6: Commit**

```bash
rtk git add core/internal/website core/internal/auth core/internal/app
rtk git commit -m "feat(website): visitor profile and ERP-side website-user admin"
```

---

### Task 10: Website session in the Next BFF

**Files:**
- Create: `core-front/apps/shell/src/lib/site-session.ts`
- Create: `core-front/apps/shell/app/api/site-auth/login/route.ts`, `.../signup/route.ts`, `.../logout/route.ts`, `.../refresh/route.ts`
- Modify: `core-front/apps/shell/src/lib/bff.ts` (`authUrl`/`goAuthExchange`/`goLogout` take an auth base)
- Test: `core-front/apps/shell/app/api/site-auth/login/route.test.ts`, `core-front/apps/shell/src/lib/site-session.test.ts`

**Interfaces:**
- Consumes: Go `POST /api/v1/website/auth/{login,signup,refresh,logout}` (Tasks 7–8).
- Produces: `SITE_ACCESS_COOKIE = 'eerp_site_access'`, `SITE_REFRESH_COOKIE = 'eerp_site_refresh'`; `getSiteIdentity(): Promise<Identity | null>`; `setSiteSessionCookies(tokens: TokenExchange)`; `clearSiteSessionCookies()`; `readSiteRefreshToken()`; `goAuthExchange(path, body, base?: 'auth' | 'website/auth')`; `goLogout(refreshToken, base?)`. Spec 2 builds the site pages on these.

- [ ] **Step 1: Write the failing tests**

`app/api/site-auth/login/route.test.ts` — copy the header of `app/api/auth/login/route.test.ts` (the `next/headers` cookie-jar mock, `makeJwt`, `goLoginOk`, `beforeEach`), then:

```ts
import { POST } from './route'

describe('POST /api/site-auth/login', () => {
  it('calls Go website auth and stores SITE cookies, never the ERP ones', async () => {
    const jwt = makeJwt({ sub: 'u1', tenant: 't1', aud: ['website'], exp: future })
    const fetchMock = vi.fn(async () => goLoginOk(jwt, 'r1'))
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(loginRequest({ email: 'v@x.io', password: 'correct horse' }))

    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/website/auth/login')
    expect(cookieJar.get('eerp_site_access')).toBe(jwt)
    expect(cookieJar.get('eerp_site_refresh')).toBe('r1')
    expect(cookieJar.has('eerp_access')).toBe(false)
  })

  it('passes a Go error through with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' } }), { status: 401 })))
    const res = await POST(loginRequest({ email: 'v@x.io', password: 'bad' }))
    expect(res.status).toBe(401)
    expect(cookieJar.size).toBe(0)
  })
})
```

`src/lib/site-session.test.ts` (same `next/headers` mock):

```ts
import { getSiteIdentity } from './site-session'

it('reads identity from the site cookie only', async () => {
  cookieJar.set('eerp_access', makeJwt({ sub: 'staff', tenant: 't', exp: future }))
  expect(await getSiteIdentity()).toBeNull()
  cookieJar.set('eerp_site_access', makeJwt({ sub: 'visitor', tenant: 't', aud: ['website'], exp: future }))
  expect((await getSiteIdentity())?.userId).toBe('visitor')
})
```

(Check `identityFromAccessToken`'s returned field name for `sub` in `src/lib/jwt.ts` and use it instead of `userId` if different.)

- [ ] **Step 2: Run to verify they fail**

Run: `rtk pnpm --filter shell vitest run app/api/site-auth src/lib/site-session.test.ts` (in the node:22 container)
Expected: FAIL — module `./route` not found.

- [ ] **Step 3: Implement**

`bff.ts` — thread an auth base through:

```ts
export type AuthBase = 'auth' | 'website/auth'

function authUrl(path: string, base: AuthBase = 'auth'): string {
  ...
  return `${apiBase}/api/v${version}/${base}/${path}`
}

export async function goAuthExchange(path: string, body: unknown, base: AuthBase = 'auth'): Promise<TokenExchange> {
  const res = await fetch(authUrl(path, base), { ... })   // rest unchanged
```

and `goLogout(refreshToken: string, base: AuthBase = 'auth')` likewise. Existing callers are unchanged (default `'auth'`).

`src/lib/site-session.ts`:

```ts
import 'server-only'
import { cookies } from 'next/headers'
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, sessionCookieOptions } from '@eerp/core-front/server'
import type { Identity } from '@eerp/core-front'
import type { TokenExchange } from './bff'
import { identityFromAccessToken } from './jwt'

// Website (visitor) session — ADR-024. Deliberately separate cookies from the
// ERP session (eerp_access/eerp_refresh): a staff member can be logged in to
// both, and a website token must never be sent on an ERP call.
export const SITE_ACCESS_COOKIE = 'eerp_site_access'
export const SITE_REFRESH_COOKIE = 'eerp_site_refresh'

export async function getSiteIdentity(): Promise<Identity | null> {
  return identityFromAccessToken((await cookies()).get(SITE_ACCESS_COOKIE)?.value)
}

export async function setSiteSessionCookies(tokens: TokenExchange): Promise<void> {
  const store = await cookies()
  store.set(SITE_ACCESS_COOKIE, tokens.accessToken, sessionCookieOptions(tokens.expiresIn ?? ACCESS_TTL_SECONDS))
  if (tokens.refreshToken) {
    store.set(SITE_REFRESH_COOKIE, tokens.refreshToken, sessionCookieOptions(REFRESH_TTL_SECONDS))
  }
}

export async function clearSiteSessionCookies(): Promise<void> {
  const store = await cookies()
  store.delete(SITE_ACCESS_COOKIE)
  store.delete(SITE_REFRESH_COOKIE)
}

export async function readSiteRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(SITE_REFRESH_COOKIE)?.value
}
```

`app/api/site-auth/login/route.ts` (signup is identical with `'signup'` and `{ email, password, name }`):

```ts
import { NextResponse } from 'next/server'
import { ApiError } from '@eerp/core-front/server'
import { goAuthExchange } from '@/lib/bff'
import { identityFromAccessToken } from '@/lib/jwt'
import { setSiteSessionCookies } from '@/lib/site-session'

// POST /api/site-auth/login {email, password} — website visitor login (ADR-024).
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string }
  try {
    const tokens = await goAuthExchange('login', { email: body.email, password: body.password }, 'website/auth')
    await setSiteSessionCookies(tokens)
    return NextResponse.json({ identity: identityFromAccessToken(tokens.accessToken) })
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: { code: e.code, message: e.message, requestId: e.requestId } }, { status: e.status })
    }
    throw e
  }
}
```

`refresh/route.ts`: read `readSiteRefreshToken()`; if absent → 401 JSON; else `goAuthExchange('refresh', { refresh_token }, 'website/auth')`, `setSiteSessionCookies`, return identity; on `ApiError` → `clearSiteSessionCookies()` and return the error status.
`logout/route.ts`: `const r = await readSiteRefreshToken(); if (r) await goLogout(r, 'website/auth'); await clearSiteSessionCookies(); return new NextResponse(null, { status: 204 })`.

Mirror `app/api/auth/refresh/route.ts` and `logout/route.ts` for exact shapes.

- [ ] **Step 4: Run to verify they pass, plus the shell suite and types**

Run: `rtk pnpm --filter shell vitest run` and `rtk tsc --noEmit -p core-front/apps/shell`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell/src/lib core-front/apps/shell/app/api/site-auth
rtk git commit -m "feat(shell): website visitor session in the BFF, separate from the ERP session"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md` (root): `internal/` package list — add `internal/website/`; ORM section — a "Public read scope" paragraph after "Field-level group gating"; Configuration — `website_tenant_id`, `public_rate_limit_per_minute`.
- Modify: `core-front/CLAUDE.md` — a "Website session" table row (cookies, BFF routes, why separate).
- Modify: `docs/adr/ADR-024-public-access-and-website-identities.md` — status `accepted`; add the implementation deltas below.
- Modify: `docs/superpowers/specs/2026-09-29-website-1-public-access-design.md` — align with the deltas.

- [ ] **Step 1: Write the docs**

Deltas to record (ADR "Implementation notes" section + spec edits):
- Selections are stored at `company_id = uuid.Nil` (settings are company-keyed; Nil is the site-wide slot), filter values are strings (text comparison).
- `WithPublicFields` does not validate names (picture anchors aren't columns).
- Admin website-user API is `/api/v1/website_admin/users` (list + PUT, no GET `:id`); "lock" = soft-delete + refresh-token revocation.
- Website session = two cookies `eerp_site_access`/`eerp_site_refresh`, BFF routes `/api/site-auth/*`.
- Public and website groups rate-limit at `public_rate_limit_per_minute` (default 300); signup/login at the auth limit.
- The site tenant is resolved at boot (a dbmanage hot-swap keeps the old one until restart).
- Picture public route and sort param: not in this plan — the public picture route moves to spec 2 (first consumer), and the generic list has no sort param today.
- Relations: a many2one value is returned as its raw id only if the column itself is published; labels are the consumer's job (spec 2 blocks fetch the target through its own public route).

Root CLAUDE.md ORM paragraph (concise):

```markdown
**Public read scope** (`docs/adr/ADR-024-public-access-and-website-identities.md`): a module declares a table's public-capable fields with `orm.Register[T](orm.WithPublicFields(...))`; an admin publishes a subset (+ an optional forced row filter) under `app_settings` `website.public.<table>` (`PUT /api/v1/settings/website/public/:table`). `/api/v1/public/{table}[/:id]` (no JWT, rate-limited, site tenant from `website_tenant_id`) reuses the generic list/get handlers with an `access.PublicScope` on the context, enforced by the same `checkColumn`/`BuildResponse` choke points as group gating, plus the forced filter on every read. Unpublished → 404; non-public column in any param → 400; `?aggregate=` refused. Website visitors are `users.kind = 'website'` with `aud: ["website"]` tokens; `authenticate` refuses the wrong audience on every group (403).
```

- [ ] **Step 2: Verify links**

Run: `rtk rg -n "ADR-024" CLAUDE.md core-front/CLAUDE.md docs`
Expected: every reference resolves to `docs/adr/ADR-024-public-access-and-website-identities.md`.

- [ ] **Step 3: Commit**

```bash
rtk git add CLAUDE.md core-front/CLAUDE.md docs
rtk git commit -m "docs(website): public read scope, website identities, ADR-024 accepted"
```
