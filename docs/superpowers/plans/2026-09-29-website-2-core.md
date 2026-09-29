# Website Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a public website at `/` built from staff-designed pages (drag-and-drop grid of blocks bound to published data, live preview), move the ERP under `/app`, and let an admin switch to host-based routing (`site_host` / `erp_host`).

**Architecture:** A `website` Go module owns `website_page` (generic CRUD, JSONB `layout` of blocks, validated by a route middleware in front of the generic Create/Update). Pages and the data blocks read are served anonymously through spec 1's `/api/v1/public/*`. In Next, the ERP's pages move from `app/` to `app/app/` (its chrome moves into `app/app/layout.tsx`); module route paths stay module-relative (`/crm/:id`) in the registry and descriptors, and ONE helper, `erpPath()`, prefixes `/app` wherever a link is emitted. The public site lives in `app/(site)/` and renders blocks server-side from `src/website/blocks`, the same components the editor canvas renders, so the preview cannot drift. `proxy.ts` gains a pure `routeDecision()` for path/host modes.

**Tech Stack:** Go / Echo v5 / pgx; Next.js 16 App Router, React, MUI, `react-grid-layout` (already installed), Vitest; nginx + openssl (dev certs).

**Spec:** `docs/superpowers/specs/2026-09-29-website-2-core-design.md` · **Depends on:** spec 1 plan (`docs/superpowers/plans/2026-09-29-website-1-public-access.md`) fully merged.

## Global Constraints

- Prefix commands with `rtk`; search with `rg`.
- Backend tests: `rtk make run-back-tests BACKTESTPATH=./<pkg>/... ARGS="-run X"` (repo root). Frontend: run pnpm/vitest in the node:22 container (dev-env memory): `pnpm --filter shell vitest run <path>`, `pnpm --filter @eerp/core-front vitest run <path>`, `tsc --noEmit -p <pkg>`.
- `depguard`: no `fmt.Print*`/`log` in Go.
- Every new user-visible string goes through `<T text="…"/>` / `useT()` and is added to `core-front/apps/shell/i18n/shell.pot` + `fr.po` (French translation) in the same task.
- ERP base path: `ERP_BASE = '/app'`. The registry, descriptors, `formPath`s and module `path`s stay module-relative; only emitted links are prefixed, via `erpPath()` (idempotent).
- Paths that stay at the root: `/api/*`, `/print/*` (pdf-service target), `/database/management`, `/_next/*`.
- Reserved first path segments a page slug may never take: `app`, `api`, `print`, `database`, `login`, `signup`, `account`, `booking`, `_next`, `favicon.ico`.
- Block types (closed set, Go and TS must agree): `text`, `image`, `hero`, `record_list`, `record_detail`, `event_booking`, `appointment_booking` (the last two render a placeholder until spec 4).
- Grid: 12 columns, row height 40 px; below the `md` breakpoint blocks stack by (`y`, `x`).
- Routing setting key `website.routing` (company `uuid.Nil`), default `{mode:"path"}`; env override `EERP_SITE_ROUTING=path`.
- Commits `<type>(scope): …` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, on `dev`.

## Review Focus

1. **Slug edge cases** — `""` (home), `Products` (uppercase), `a/b`, `app`, `api` and a duplicate slug in the same tenant: lowercase `[a-z0-9-]` only, reserved list refused, duplicates 409 (Task 1 tests).
2. **A block referencing a field that was unpublished later** — the page still renders, the field is simply absent; a block on an unpublished table renders nothing instead of crashing the page (Task 5 tests).
3. **Deep links into the ERP after the move** — an old bookmark `/crm/42` must not 404 into the site; `/crm/…` for a known module root redirects to `/app/crm/…` (Task 4 test on `routeDecision`).
4. **Host mode with a mistyped `erp_host`** — saving is refused unless the save request came through that host; `EERP_SITE_ROUTING=path` recovers (Task 7 + Task 9 tests).
5. **Phone width** — the public page and the editor stack blocks in one column, no horizontal scroll (Task 5 + Task 8 tests assert the stacked order).

---

## File Structure

| File | Responsibility |
|---|---|
| `core/modules/website/{module.go,module.json,handler.go,views/website_views.ts,package.json,…}` | Go module (scaffolded) + ERP descriptors |
| `core/orm/server/public.go` | + public picture route |
| `core/internal/website/routing.go` | routing setting API + public site info |
| `core/internal/app/app.go` | wiring |
| `core-front/packages/core-front/src/navigation.ts` | `ERP_BASE`, `erpPath()` |
| `core-front/apps/shell/app/layout.tsx` | minimal root layout (html/body/theme/i18n) |
| `core-front/apps/shell/app/app/**` | the ERP (moved) + `layout.tsx` with ERP chrome |
| `core-front/apps/shell/app/(site)/**` | public site pages + site auth pages |
| `core-front/apps/shell/src/website/{types.ts,public-api.ts,blocks/*}` | block model, public fetch, block components |
| `core-front/apps/shell/app/app/website/pages/[id]/design/**` | the editor |
| `core-front/apps/shell/app/app/settings/website/**` | published data, routing, website users |
| `core-front/apps/shell/src/lib/routing.ts` + `proxy.ts` | `routeDecision()` + wiring |
| `infra/nginx/gen-certs.sh`, `infra/nginx/README.md` | SANs, prod certs |

---

### Task 1: `website` Go module — pages, validation, public declaration

**Files:**
- Create (scaffold): `core/modules/website/` via `go run ./tools/eerp-init-module -p core/modules/website -t go`
- Modify: `core/modules/website/module.go`, `core/modules/website/module.json`
- Create: `core/modules/website/validate.go`, `core/modules/website/validate_test.go`
- Modify: `core/internal/app/app.go` (mount the validation middleware; seed the page selection)
- Test: `core/internal/app/website_test.go` (append)

**Interfaces:**
- Consumes: spec 1 — `orm.WithPublicFields`, `website.PublicKey`, `website.Selection`, `handlers` map + `siteTenant` in `mountRoutes`.
- Produces: table `website_page` (`slug`, `title`, `seo_description`, `published`, `in_menu`, `menu_sequence`, `layout` JSONB); `websitemodule.ValidatePageBody` (`echo.MiddlewareFunc`); `websitemodule.BlockTypes` (`map[string]bool`); `websitemodule.ReservedSlugs`.

- [ ] **Step 1: Scaffold**

Run from the repo root: `go run ./tools/eerp-init-module -p core/modules/website -t go` (use the repo's Go invocation). It creates `module.json`, `module.go`, the frontend views package, wires `core/modules/all/all.go`, and runs `pnpm install`. Then set `module.json`: `"display_name": "Website"`, `"app_mode": true`, `"menu_icon": "globe"`, `"description": "Public website: pages, published data"`.

- [ ] **Step 2: Write the failing tests** `validate_test.go`

```go
package website

import (
	"strings"
	"testing"
)

func TestValidatePage(t *testing.T) {
	block := func(id, typ string, x, y, w, h int) map[string]any {
		return map[string]any{"id": id, "type": typ, "x": x, "y": y, "w": w, "h": h, "config": map[string]any{}}
	}
	tests := []struct {
		name    string
		body    map[string]any
		wantErr string // substring; "" = valid
	}{
		{"home page", map[string]any{"slug": "", "layout": []any{block("a", "text", 0, 0, 12, 2)}}, ""},
		{"simple slug", map[string]any{"slug": "products"}, ""},
		{"dashes and digits", map[string]any{"slug": "events-2026"}, ""},
		{"uppercase", map[string]any{"slug": "Products"}, "slug"},
		{"nested path", map[string]any{"slug": "a/b"}, "slug"},
		{"reserved app", map[string]any{"slug": "app"}, "reserved"},
		{"reserved api", map[string]any{"slug": "api"}, "reserved"},
		{"unknown block type", map[string]any{"layout": []any{block("a", "iframe", 0, 0, 1, 1)}}, "type"},
		{"duplicate block id", map[string]any{"layout": []any{block("a", "text", 0, 0, 1, 1), block("a", "text", 0, 1, 1, 1)}}, "duplicate"},
		{"negative x", map[string]any{"layout": []any{block("a", "text", -1, 0, 1, 1)}}, "x/y"},
		{"zero width", map[string]any{"layout": []any{block("a", "text", 0, 0, 0, 1)}}, "w/h"},
		{"wider than grid", map[string]any{"layout": []any{block("a", "text", 6, 0, 7, 1)}}, "12 columns"},
		{"layout not an array", map[string]any{"layout": "nope"}, "layout"},
		{"no slug key on update is fine", map[string]any{"title": "x"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePage(tt.body)
			if tt.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}
```

Append to `core/internal/app/website_test.go`:

```go
func TestWebsitePages(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	slug := "t-" + uuid.NewString()[:8]
	t.Cleanup(func() { _, _ = c.a.db.DB.Exec(ctx, `DELETE FROM website_page WHERE slug = $1`, slug) })

	layout := []map[string]any{{"id": "b1", "type": "text", "x": 0, "y": 0, "w": 12, "h": 2, "config": map[string]any{"body": "Hi"}}}
	code, body := c.do(http.MethodPost, "/api/v1/website_page",
		map[string]any{"slug": slug, "title": "T", "published": false, "layout": layout})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create: %d %s", code, body)
	}
	id, _ := decode(t, body)["id"].(string)

	if code, _ := c.do(http.MethodPost, "/api/v1/website_page", map[string]any{"slug": slug, "title": "dup"}); code != http.StatusConflict {
		t.Errorf("duplicate slug = %d, want 409", code)
	}
	if code, _ := c.do(http.MethodPost, "/api/v1/website_page", map[string]any{"slug": "api", "title": "x"}); code != http.StatusBadRequest {
		t.Errorf("reserved slug = %d, want 400", code)
	}
	if code, _ := c.do(http.MethodPut, "/api/v1/website_page/"+id, map[string]any{"layout": []map[string]any{{"id": "x", "type": "iframe", "x": 0, "y": 0, "w": 1, "h": 1}}}); code != http.StatusBadRequest {
		t.Errorf("bad block type on update = %d, want 400", code)
	}

	// Unpublished page is invisible publicly; published one is visible.
	if code, _ := anon.do(http.MethodGet, "/api/v1/public/website_page?filter[slug]="+slug, nil); code != http.StatusOK {
		t.Fatalf("public list = %d", code)
	}
	_, body = anon.do(http.MethodGet, "/api/v1/public/website_page?filter[slug]="+slug, nil)
	if decode(t, body)["total"].(float64) != 0 {
		t.Error("unpublished page visible publicly")
	}
	c.do(http.MethodPut, "/api/v1/website_page/"+id, map[string]any{"published": true})
	_, body = anon.do(http.MethodGet, "/api/v1/public/website_page?filter[slug]="+slug, nil)
	if decode(t, body)["total"].(float64) != 1 {
		t.Errorf("published page not visible: %s", body)
	}
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `rtk make run-back-tests BACKTESTPATH=./modules/website/...` and `BACKTESTPATH=./internal/app/... ARGS="-run TestWebsitePages"`
Expected: FAIL — `undefined: validatePage` / 404 on `/api/v1/website_page`.

- [ ] **Step 4: Implement**

`module.go` (replace the scaffold's model/registration):

```go
// Package website is the public website's page model: pages staff compose
// from blocks in the ERP (Website app), served anonymously through
// /api/v1/public (ADR-024). See docs/superpowers/specs/2026-09-29-website-2-core-design.md.
package website

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/orm"
	"core/orm/model"
)

func init() { module.RegisterGoModule(&websiteModule{}) }

// WebsitePage is one public page. Slug "" is the home page. Layout is the
// ordered block grid (JSONB) — validated by ValidatePageBody, rendered by
// core-front's src/website/blocks.
type WebsitePage struct {
	model.BaseModel
	Slug           string           `db:"slug" json:"slug"`
	Title          string           `db:"title" json:"title"`
	SEODescription string           `db:"seo_description" json:"seo_description"`
	Published      bool             `db:"published" json:"published"`
	InMenu         bool             `db:"in_menu" json:"in_menu"`
	MenuSequence   int              `db:"menu_sequence" json:"menu_sequence"`
	Layout         []map[string]any `db:"layout" json:"layout"`
}

type websiteModule struct{}

func (m *websiteModule) Name() string { return "website" }

func (m *websiteModule) Register() error {
	return orm.Register[WebsitePage](
		orm.WithTableName("website_page"),
		orm.WithPublicFields("slug", "title", "seo_description", "in_menu", "menu_sequence", "layout"),
	)
}

// Migrate adds the per-tenant unique slug (struct tags can't express one).
func (m *websiteModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_website_page_tenant_slug
		ON website_page (tenant_id, slug) WHERE deleted_at IS NULL`); err != nil {
		return fmt.Errorf("website: create slug index: %w", err)
	}
	return nil
}
```

(Keep whatever other methods the scaffold generated for the module interface; match their signatures.)

`validate.go`:

```go
package website

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"github.com/labstack/echo/v5"
)

// BlockTypes is the closed set of block types — keep in sync with
// core-front/apps/shell/src/website/types.ts BLOCK_TYPES.
var BlockTypes = map[string]bool{
	"text": true, "image": true, "hero": true, "record_list": true, "record_detail": true,
	"event_booking": true, "appointment_booking": true,
}

// ReservedSlugs are first path segments the site can never own.
var ReservedSlugs = map[string]bool{
	"app": true, "api": true, "print": true, "database": true, "login": true, "signup": true,
	"account": true, "booking": true, "_next": true, "favicon.ico": true,
}

const gridCols = 12

var (
	slugPattern    = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	blockIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	errPage        = errors.New("invalid page")
)

type block struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// validatePage checks the keys present in body (a PUT may send a subset).
func validatePage(body map[string]any) error {
	if raw, ok := body["slug"]; ok {
		slug, _ := raw.(string)
		if ReservedSlugs[slug] {
			return fmt.Errorf("%w: slug %q is reserved", errPage, slug)
		}
		if slug != "" && !slugPattern.MatchString(slug) {
			return fmt.Errorf("%w: slug must be lowercase letters, digits and dashes", errPage)
		}
	}
	raw, ok := body["layout"]
	if !ok || raw == nil {
		return nil
	}
	enc, _ := json.Marshal(raw)
	var blocks []block
	if err := json.Unmarshal(enc, &blocks); err != nil {
		return fmt.Errorf("%w: layout must be an array of blocks", errPage)
	}
	seen := map[string]bool{}
	for _, b := range blocks {
		switch {
		case !blockIDPattern.MatchString(b.ID):
			return fmt.Errorf("%w: block id %q must be 1-64 letters, digits, - or _", errPage, b.ID)
		case seen[b.ID]:
			return fmt.Errorf("%w: duplicate block id %q", errPage, b.ID)
		case !BlockTypes[b.Type]:
			return fmt.Errorf("%w: block %q: unknown type %q", errPage, b.ID, b.Type)
		case b.X < 0 || b.Y < 0:
			return fmt.Errorf("%w: block %q: x/y must be >= 0", errPage, b.ID)
		case b.W < 1 || b.H < 1:
			return fmt.Errorf("%w: block %q: w/h must be >= 1", errPage, b.ID)
		case b.X+b.W > gridCols:
			return fmt.Errorf("%w: block %q exceeds the grid's 12 columns", errPage, b.ID)
		}
		seen[b.ID] = true
	}
	return nil
}

// ValidatePageBody runs in front of the GENERIC website_page Create/Update
// handlers (mounted after them in app.go, so Echo keeps these registrations):
// it validates, then restores the body for the generic handler to bind.
func ValidatePageBody(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		raw, err := io.ReadAll(c.Request().Body)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
		}
		if err := validatePage(body); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		c.Request().Body = io.NopCloser(bytes.NewReader(raw))
		return next(c)
	}
}
```

Duplicate slug → the unique index raises 23505. Check how the generic Create maps a unique violation today (`rtk rg -n "23505" core/orm`); if it doesn't yield 409, add the mapping in `core/orm/internal/handler/generic_handler.go` `Create`/`Update` (`errors.As(err, &pgErr) && pgErr.Code == "23505"` → `echo.NewHTTPError(http.StatusConflict, "a record with this value already exists")`) with a handler unit test — every table with a unique index benefits.

`app.go`, after `srv.RegisterRoutes(handlers, …)` (with the other overrides):

```go
	// ── website: page validation in front of the generic Create/Update ───────
	pageH := handlers["website_page"]
	srv.Echo().POST("/api/v1/website_page", pageH.Create, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware(), websitemodule.ValidatePageBody)
	srv.Echo().PUT("/api/v1/website_page/:id", pageH.Update, jwtMw, permMw, moduleRuntime.ActiveGateMiddleware(), websitemodule.ValidatePageBody)
```

and inside the `siteTenant != uuid.Nil` block, seed the page selection once (never overwrite an admin's choice):

```go
		pagesKey := website.PublicKey("website_page")
		if _, found, err := settingsStore.Get(ctx, siteTenant, uuid.Nil, pagesKey); err == nil && !found {
			sel, _ := json.Marshal(website.Selection{
				Fields: []string{"slug", "title", "seo_description", "in_menu", "menu_sequence", "layout"},
				Filter: map[string]string{"published": "true"},
			})
			_ = settingsStore.Set(ctx, siteTenant, uuid.Nil, pagesKey, string(sel))
		}
```

(`websitemodule` = import alias for `core/modules/website`; `website` = `core/internal/website`.)

- [ ] **Step 5: Run to verify they pass, plus all backend**

Run: `rtk make run-back-tests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add core/modules/website core/modules/all/all.go core/internal/app core/orm core-front/pnpm-lock.yaml
rtk git commit -m "feat(website): website_page module with slug/layout validation"
```

---

### Task 2: Public picture route

**Files:**
- Modify: `core/orm/server/public.go`, `core/orm/internal/handler/generic_handler.go`
- Modify: `core/internal/app/app.go`
- Test: `core/orm/server/public_test.go` (append), `core/internal/app/website_test.go` (append)

**Interfaces:**
- Consumes: spec 1 `MountPublic`, `PublicScopeMiddleware`; `pictures.Repository.FindByAnchor`, `pictures.ObjectStore.Get`.
- Produces: `type PictureServer func(c *echo.Context, table string, recordID uuid.UUID, field string) error`; `MountPublic(g, handlers, resolve, pictures PictureServer)` (new last param, `nil` = no picture route); route `GET /api/v1/public/<table>/:id/picture/:field`; `(*GenericHandler).Visible(ctx, id uuid.UUID) (bool, error)`.

- [ ] **Step 1: Write the failing test** (append to `public_test.go`)

```go
func TestPublicPictureGuard(t *testing.T) {
	scope := access.PublicScope{Columns: []string{"id", "name", "picture"}}
	tests := []struct {
		name    string
		field   string
		visible bool
		want    int
	}{
		{"published field on a visible record", "picture", true, http.StatusOK},
		{"field not published", "logo", true, http.StatusNotFound},
		{"record outside the scope", "picture", false, http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := echo.New()
			served := false
			h := publicPicture("product",
				func(context.Context, uuid.UUID) (bool, error) { return tt.visible, nil },
				func(c *echo.Context, _ string, _ uuid.UUID, _ string) error { served = true; return c.NoContent(http.StatusOK) })
			e.GET("/p/:id/picture/:field", h, func(next echo.HandlerFunc) echo.HandlerFunc {
				return func(c *echo.Context) error {
					c.SetRequest(c.Request().WithContext(access.WithPublicScope(c.Request().Context(), scope)))
					return next(c)
				}
			})
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/"+uuid.NewString()+"/picture/"+tt.field, nil))
			if rec.Code != tt.want || served != (tt.want == http.StatusOK) {
				t.Errorf("code=%d served=%v, want %d", rec.Code, served, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./orm/server/... ARGS="-run TestPublicPictureGuard"`
Expected: FAIL — `undefined: publicPicture`.

- [ ] **Step 3: Implement**

`generic_handler.go`:

```go
// Visible reports whether id is readable under ctx's scope (tenant, soft
// delete, public filter) — the public picture route's record check.
func (h *GenericHandler) Visible(ctx context.Context, id uuid.UUID) (bool, error) {
	_, err := h.svc.GetByID(ctx, id)
	if errors.Is(err, crud.ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}
```

`public.go`:

```go
// PictureServer streams the picture anchored on (table, record, field).
type PictureServer func(c *echo.Context, table string, recordID uuid.UUID, field string) error

// publicPicture serves a picture only when field is in the caller's public
// scope and the record itself is visible under it (forced filter included).
func publicPicture(table string, visible func(context.Context, uuid.UUID) (bool, error), serve PictureServer) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		scope, _ := access.PublicScopeFromContext(ctx)
		field := c.Param("field")
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil || !scope.Allows(field) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		ok, err := visible(ctx, id)
		if err != nil {
			return err
		}
		if !ok {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		return serve(c, table, id, field)
	}
}
```

Change `MountPublic`'s signature to `MountPublic(g *echo.Group, handlers map[string]*handler.GenericHandler, resolve PublicResolver, pictures PictureServer)` and inside the loop add:

```go
		if pictures != nil {
			g.GET(prefix+"/:id/picture/:field", publicPicture(meta.TableName, h.Visible, pictures), mw)
		}
```

Update spec 1's call site in `app.go` accordingly. In the S3 block of `app.go` keep a reference to the pictures repo/objects, then build:

```go
	var publicPictures ormserver.PictureServer
	if pictures.S3Configured(configContent) {
		picRepo := pictures.NewRepository(app.DB)
		publicPictures = func(c *echo.Context, table string, recordID uuid.UUID, field string) error {
			ctx := c.Request().Context()
			tenant, _ := access.TenantFromContext(ctx)
			p, err := picRepo.FindByAnchor(ctx, tenant, table, recordID, field)
			if errors.Is(err, orm.ErrNotFound) {
				return echo.NewHTTPError(http.StatusNotFound, "not found")
			}
			if err != nil {
				return err
			}
			body, ctype, err := objects.Get(ctx, p.ObjectKey)
			if err != nil {
				return err
			}
			defer func() { _ = body.Close() }()
			if p.Mime != "" {
				ctype = p.Mime
			}
			c.Response().Header().Set("Cache-Control", "public, max-age=300")
			return c.Stream(http.StatusOK, ctype, body)
		}
	}
```

(`objects` is the pictures S3 store already built in that block — hoist it to a variable visible here.) Pass `publicPictures` to `MountPublic`.

- [ ] **Step 4: Run to verify, plus all backend**

Run: `rtk make run-back-tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/orm core/internal/app
rtk git commit -m "feat(website): public picture route gated by the published scope"
```

---

### Task 3: Routing setting and public site info

**Files:**
- Create: `core/internal/website/routing.go`, `core/internal/website/routing_test.go`
- Modify: `core/internal/app/app.go`

**Interfaces:**
- Consumes: spec 1 `SettingsStore`, `siteTenant`.
- Produces: `website.Routing{Mode, SiteHost, ERPHost string}` (json `mode`, `site_host`, `erp_host`); `website.RoutingKey = "website.routing"`; `website.NewRoutingHandler(store SettingsStore, siteTenant uuid.UUID) *RoutingHandler` with `Get`/`Put` (ERP, `settings:website:read|write`) and `PublicSite` (`GET /api/v1/public/site` → `{"routing": Routing}`); `validateRouting(r Routing, requestHost string) error`. The request host is read from header `X-EERP-Request-Host` (set by the Next BFF from the browser's Host), falling back to `Host`.

- [ ] **Step 1: Write the failing test**

```go
package website

import "testing"

func TestValidateRouting(t *testing.T) {
	tests := []struct {
		name    string
		r       Routing
		host    string
		wantErr bool
	}{
		{"path mode needs nothing", Routing{Mode: "path"}, "localhost", false},
		{"host mode from erp host", Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}, "erp.acme.fr", false},
		{"host mode with port on request", Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}, "erp.acme.fr:443", false},
		{"host mode from elsewhere is refused (lockout guard)", Routing{Mode: "host", SiteHost: "www.acme.fr", ERPHost: "erp.acme.fr"}, "localhost", true},
		{"host mode missing a host", Routing{Mode: "host", ERPHost: "erp.acme.fr"}, "erp.acme.fr", true},
		{"same host twice", Routing{Mode: "host", SiteHost: "a.fr", ERPHost: "a.fr"}, "a.fr", true},
		{"host with a path", Routing{Mode: "host", SiteHost: "a.fr/x", ERPHost: "b.fr"}, "b.fr", true},
		{"unknown mode", Routing{Mode: "magic"}, "x", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateRouting(tt.r, tt.host); (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/website/... ARGS="-run TestValidateRouting"`
Expected: FAIL.

- [ ] **Step 3: Implement** `routing.go`

```go
package website

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// RoutingKey stores how the site and the ERP share hostnames.
const RoutingKey = "website.routing"

// Routing: "path" (default) — site at /, ERP at /app, any host; "host" — the
// site on SiteHost, the ERP on ERPHost (see core-front src/lib/routing.ts).
type Routing struct {
	Mode     string `json:"mode"`
	SiteHost string `json:"site_host"`
	ERPHost  string `json:"erp_host"`
}

var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

var errRouting = errors.New("invalid routing")

// validateRouting refuses host mode unless the save itself arrived through
// ERPHost — proof that name already resolves here, so the admin can't lock
// themselves out of the ERP by saving a typo.
func validateRouting(r Routing, requestHost string) error {
	switch r.Mode {
	case "path":
		return nil
	case "host":
	default:
		return fmt.Errorf("%w: mode must be path or host", errRouting)
	}
	if !hostPattern.MatchString(r.SiteHost) || !hostPattern.MatchString(r.ERPHost) {
		return fmt.Errorf("%w: site_host and erp_host must be bare host names", errRouting)
	}
	if r.SiteHost == r.ERPHost {
		return fmt.Errorf("%w: site_host and erp_host must differ", errRouting)
	}
	if h, _, err := net.SplitHostPort(requestHost); err == nil {
		requestHost = h
	}
	if !strings.EqualFold(requestHost, r.ERPHost) {
		return fmt.Errorf("%w: open the ERP through https://%s/ and save from there, so a mistyped host can't lock you out", errRouting, r.ERPHost)
	}
	return nil
}

type RoutingHandler struct {
	store      SettingsStore
	siteTenant uuid.UUID
}

func NewRoutingHandler(store SettingsStore, siteTenant uuid.UUID) *RoutingHandler {
	return &RoutingHandler{store: store, siteTenant: siteTenant}
}

func (h *RoutingHandler) load(ctx context.Context, tenant uuid.UUID) (Routing, error) {
	raw, found, err := h.store.Get(ctx, tenant, uuid.Nil, RoutingKey)
	if err != nil {
		return Routing{}, err
	}
	r := Routing{Mode: "path"}
	if found && raw != "" {
		_ = json.Unmarshal([]byte(raw), &r) // unparsable degrades to path mode
	}
	return r, nil
}

// Get handles GET /api/v1/settings/website/routing.
func (h *RoutingHandler) Get(c *echo.Context) error {
	r, err := h.load(c.Request().Context(), auth.MustIdentity(c.Request().Context()).TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, r)
}

// Put handles PUT /api/v1/settings/website/routing.
func (h *RoutingHandler) Put(c *echo.Context) error {
	var r Routing
	if err := c.Bind(&r); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	r.SiteHost, r.ERPHost = strings.ToLower(strings.TrimSpace(r.SiteHost)), strings.ToLower(strings.TrimSpace(r.ERPHost))
	host := c.Request().Header.Get("X-EERP-Request-Host")
	if host == "" {
		host = c.Request().Host
	}
	if err := validateRouting(r, host); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	raw, _ := json.Marshal(r)
	ctx := c.Request().Context()
	if err := h.store.Set(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, RoutingKey, string(raw)); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// PublicSite handles GET /api/v1/public/site — what the Next proxy needs to
// route a request, readable anonymously.
func (h *RoutingHandler) PublicSite(c *echo.Context) error {
	r, err := h.load(c.Request().Context(), h.siteTenant)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"routing": r})
}
```

`app.go`: in the settings block, `routing := website.NewRoutingHandler(settingsStore, siteTenant)`; `settingsGroup.GET("/website/routing", routing.Get)`; `settingsGroup.PUT("/website/routing", routing.Put)`. In the `siteTenant != uuid.Nil` block: `publicGroup.GET("/site", routing.PublicSite)` (register it before `MountPublic`; Echo prefers the static `/site` over `/:table` anyway). When the site tenant is unresolved, also mount `srv.Echo().GET("/api/v1/public/site", …)` returning `{"routing":{"mode":"path"}}` so the proxy always gets an answer.

- [ ] **Step 4: Run to verify, plus all backend**

Run: `rtk make run-back-tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/website core/internal/app
rtk git commit -m "feat(website): routing setting with lockout guard; public site info"
```

---

### Task 4: Move the ERP under `/app`

**Files:**
- Create: `core-front/packages/core-front/src/navigation.ts` (+ `navigation.test.ts`); export from the package's client and server entry points (check `packages/core-front/src/index.ts` and `server.ts`)
- Move (git mv): `apps/shell/app/{page.tsx,page.test.tsx,Menu.tsx,Menu.test.tsx,[...module],settings,appstore,force-password-change,(auth)/login}` → `apps/shell/app/app/…` (`(auth)/login` → `app/app/login`)
- Create: `apps/shell/app/app/layout.tsx` (the ERP chrome, cut from the root layout)
- Modify: `apps/shell/app/layout.tsx` (minimal)
- Modify (prefix emitted links with `erpPath`): `packages/core-front/src/views/{kanban-renderer.tsx:184,header-menu-bar.tsx:134,146,254,relation-widgets.tsx:815,1137,1429,catalog-renderer.tsx:107,calendar-renderer.tsx:247,renderers.tsx:176,276,404,408,1050,1213,error-alert.tsx}`, `apps/shell/src/lib/session.ts`, `apps/shell/src/components/{AppTopBar,UsersSettingsButton,DeveloperSettings,AppsList}.tsx`, `apps/shell/app/app/{Menu.tsx,force-password-change/PasswordChangeForm.tsx,settings/SettingsHub.tsx,login/page.tsx}`, `apps/shell/app/app/[...module]/page.tsx` (`requireAuth(erpPath(modulePathFromSegments(segments)))`), every `requireAuth('/settings/…')` literal
- Create: `apps/shell/src/lib/routing.ts` (+ test) — `routeDecision()` (path-mode part; host mode lands in Task 9)
- Modify: `apps/shell/proxy.ts` (call `routeDecision` for legacy-path redirects)
- Test: `navigation.test.ts`, `routing.test.ts`, existing tests updated to the new paths

**Interfaces:**
- Produces: `ERP_BASE = '/app'`; `erpPath(path: string): string` (idempotent; `'/'` → `'/app'`; keeps query/hash); `routeDecision(input: { pathname: string; host: string; erpRoots: ReadonlySet<string>; routing: Routing }): { kind: 'next' } | { kind: 'redirect'; location: string }` (`Routing` type mirrors Go: `{ mode: 'path' | 'host'; site_host?: string; erp_host?: string }`); `erpRoots` = first segments of every registered module route + `settings`, `appstore`, `force-password-change`.

- [ ] **Step 1: Write the failing tests**

`navigation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { erpPath } from './navigation'

describe('erpPath', () => {
  it.each([
    ['/crm/42', '/app/crm/42'],
    ['/', '/app'],
    ['/settings/users?tab=roles', '/app/settings/users?tab=roles'],
    ['/app/crm', '/app/crm'], // idempotent
    ['/app', '/app'],
    ['/apple/1', '/app/apple/1'], // a module named "apple" is not already prefixed
  ])('%s -> %s', (input, want) => expect(erpPath(input)).toBe(want))
})
```

`apps/shell/src/lib/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { routeDecision } from './routing'

const erpRoots = new Set(['crm', 'settings', 'invoice'])
const path = { mode: 'path' as const }

describe('routeDecision — path mode', () => {
  it.each([
    ['/', { kind: 'next' }],
    ['/products', { kind: 'next' }],
    ['/app/crm/42', { kind: 'next' }],
    // Review Focus #3: old ERP bookmarks keep working.
    ['/crm/42', { kind: 'redirect', location: '/app/crm/42' }],
    ['/settings/users', { kind: 'redirect', location: '/app/settings/users' }],
    ['/api/v1/public/site', { kind: 'next' }],
    ['/print/report/x/1', { kind: 'next' }],
  ])('%s', (pathname, want) => {
    expect(routeDecision({ pathname, host: 'localhost', erpRoots, routing: path })).toEqual(want)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `rtk pnpm --filter @eerp/core-front vitest run src/navigation.test.ts` and `rtk pnpm --filter shell vitest run src/lib/routing.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the helpers**

`navigation.ts`:

```ts
/** Where the ERP lives once the public website owns `/` (website spec 2).
 * Module route paths, descriptors and formPaths stay module-relative
 * ('/crm/:id'); erpPath() is applied ONLY where a link is emitted. */
export const ERP_BASE = '/app'

/** Prefix an ERP path with ERP_BASE. Idempotent. */
export function erpPath(path: string): string {
  if (path === ERP_BASE || path.startsWith(ERP_BASE + '/') || path.startsWith(ERP_BASE + '?')) return path
  if (path === '/' || path === '') return ERP_BASE
  return ERP_BASE + (path.startsWith('/') ? path : '/' + path)
}
```

`routing.ts`:

```ts
export interface Routing {
  mode: 'path' | 'host'
  site_host?: string
  erp_host?: string
}

export type RouteDecision = { kind: 'next' } | { kind: 'redirect'; location: string }

const ROOT_PASSTHROUGH = new Set(['app', 'api', 'print', 'database', '_next', 'favicon.ico'])

/** Pure routing decision for proxy.ts (website spec 2). */
export function routeDecision(input: {
  pathname: string
  host: string
  erpRoots: ReadonlySet<string>
  routing: Routing
}): RouteDecision {
  const first = input.pathname.split('/')[1] ?? ''
  if (ROOT_PASSTHROUGH.has(first)) return { kind: 'next' }
  // A bare ERP path (pre-/app bookmark, or a link a module still emits raw).
  if (input.erpRoots.has(first)) return { kind: 'redirect', location: '/app' + input.pathname }
  return { kind: 'next' }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Move the ERP files and split the layout**

```bash
cd core-front/apps/shell/app
mkdir -p app
git mv page.tsx page.test.tsx Menu.tsx Menu.test.tsx '[...module]' settings appstore force-password-change app/
git mv '(auth)/login' app/login
```

Root `app/layout.tsx` keeps ONLY: the global CSS imports, `<html>/<body>`, `AppRouterCacheProvider`, `AppThemeProvider`, `I18nInit`, `LocaleSync` (the site is translated too), and `{children}`. Everything else — `ModulesInit`, `SettingsUsersRegistryInit`, `SessionHydrator`, `PresenceInit`, `UndoToastHost`, `AppTopBar`, every `*OpsProvider`, the page-inset `Box` — moves verbatim into the new `app/app/layout.tsx` (a server component with the same data loading: identity, preferences, header menus, companies). Keep the `@media print` rule where it is in the moved code. `app/print/**` stays at the root; its page imports its own data, so it no longer needs the ERP chrome — confirm it still renders by running its existing test.

- [ ] **Step 6: Prefix emitted links**

Wrap every navigation target listed in **Files** with `erpPath(…)`, e.g.:

```ts
onClick={formPath ? () => router.push(erpPath(formPath.replace(':id', record.id))) : undefined}
```

`renderers.tsx:399` derives `listPath` from `formPathNow` — derive it from the module-relative formPath, then wrap the push. `session.ts`: `redirect(erpPath(\`/login${next}\`))` and `FORCE_PASSWORD_CHANGE_PATH = erpPath('/force-password-change')`; callers of `requireAuth(path)` pass module-relative paths — have `requireAuth` wrap `intendedPath` with `erpPath` itself so call sites stay unchanged. `SETTINGS_SECTIONS` paths stay module-relative; wrap at the `<Link href>`. `AppTopBar`'s links, `Menu.tsx` tiles, `AppsList`, `DeveloperSettings`, `UsersSettingsButton`, `PasswordChangeForm`'s post-change redirect, and the login page's post-login `router.replace(next ?? '/')` → `erpPath(next ?? '/')`.

Then verify nothing raw is left:

```bash
rtk rg -n "router\.(push|replace)\((?!erpPath)|redirect\(['\"\`]/(?!app)|href=\{?['\"\`]/(?!app|api|print)" core-front/apps/shell core-front/packages/core-front/src --pcre2 --glob '!*.test.*' --glob '!**/node_modules/**'
```

Expected: no output (inspect any hit — a hit on a non-ERP link like `/api/…` is fine only if it is not navigation).

- [ ] **Step 7: Proxy redirect for bare ERP paths**

In `proxy.ts`, before the session logic: build `erpRoots` once at module scope from `moduleRegistry` (import `@/generated/generated-modules` for its side effect, then collect `path.split('/')[1]` of every registered route; add `settings`, `appstore`, `force-password-change`). If `routeDecision(...)` returns a redirect, `return withCsp(NextResponse.redirect(new URL(location, request.url), 308), nonce)`. Routing is `{ mode: 'path' }` here; Task 9 fetches the real one. Extend the matcher to also skip `api/site-auth` (spec 1) the same way it skips `api/auth`.

- [ ] **Step 8: Update tests and run everything**

Update every test asserting an ERP path (`rtk rg -n "'/(crm|settings|appstore|login|force-password-change)" core-front --glob '*.test.*' --glob '!**/node_modules/**'`) to the `/app`-prefixed URL where it asserts an emitted link, and leave module-relative ones where it asserts a registry path.

Run: `rtk pnpm -r vitest run` and `rtk tsc --noEmit -p core-front/apps/shell`, `rtk tsc --noEmit -p core-front/packages/core-front`
Expected: PASS.

Manual smoke (the `run` skill or `make run`): `/app` shows the menu, `/app/crm` the CRM, `/crm/1` redirects to `/app/crm/1`, `/app/login` logs in and lands on `/app`, a PDF report still renders.

- [ ] **Step 9: Commit**

```bash
rtk git add -A core-front
rtk git commit -m "refactor(shell): move the ERP under /app; erpPath() prefixes emitted links"
```

---

### Task 5: Block model, public data fetch, block components

**Files:**
- Create: `apps/shell/src/website/types.ts`, `apps/shell/src/website/public-api.ts`, `apps/shell/src/website/blocks/{BlockView.tsx,TextBlock.tsx,ImageBlock.tsx,HeroBlock.tsx,RecordListBlock.tsx,RecordDetailBlock.tsx,PendingBlock.tsx,StackedGrid.tsx}`
- Test: `apps/shell/src/website/blocks/blocks.test.tsx`, `apps/shell/src/website/public-api.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `BLOCK_TYPES` (the closed set), `type BlockType`, `interface Block { id: string; type: BlockType; x: number; y: number; w: number; h: number; config: Record<string, unknown> }`, config types `TextConfig { heading?: string; body: string; align?: 'left'|'center'|'right' }`, `ImageConfig { table: string; record: string; field: string; alt: string; href?: string }`, `HeroConfig { title: string; subtitle?: string; cta_label?: string; cta_href?: string }`, `RecordListConfig { table: string; fields: string[]; title_field: string; filter?: Record<string,string>; page_size?: number; display?: 'grid'|'list'; detail_slug?: string; picture_field?: string }`, `RecordDetailConfig { table: string; fields: string[]; title_field: string; picture_field?: string }`; `interface PublicDataSource { list(table: string, q: { filter?: Record<string,string>; page_size?: number }): Promise<{ records: Record<string, unknown>[]; total: number } | null>; get(table: string, id: string): Promise<Record<string, unknown> | null> }`; `stackOrder(blocks: Block[]): Block[]` (sort by y, then x).
  - `public-api.ts`: `serverPublicSource: PublicDataSource` (Next server `fetch` to `${API_BASE}/api/v${API_VERSION}/public/...`, `next: { tags: ['website_page', table], revalidate: 60 }`, `null` on 404); `pictureUrl(table, record, field): string` → `/api/v1/public/${table}/${record}/picture/${field}` (browser-relative: the gateway routes `/api/v1/*` to Go); `getSitePage(slug: string)`, `getMenuPages()`.
  - `BlockView({ block, source, params }: { block: Block; source: PublicDataSource; params: { id?: string } })` — async server component dispatching on `type`; `StackedGrid({ blocks, children })` — CSS grid 12 cols ≥ md, single column below.
- Delta vs spec: the `text` block is plain text (paragraphs split on blank lines, optional heading) — no markdown dependency; `image` blocks read a picture anchored on a record field (`table`/`record`/`field`), since pages have no upload of their own in v1.

- [ ] **Step 1: Write the failing tests**

`blocks.test.tsx` (render async server components by awaiting them, the pattern used elsewhere in shell tests — check `app/app/page.test.tsx` for the exact helper):

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BlockView } from './BlockView'
import { stackOrder, type Block, type PublicDataSource } from '../types'

const source = (records: Record<string, unknown>[] | null): PublicDataSource => ({
  list: async () => (records ? { records, total: records.length } : null),
  get: async (_t, id) => records?.find((r) => r.id === id) ?? null,
})
const block = (type: Block['type'], config: Record<string, unknown>): Block => ({ id: 'b', type, x: 0, y: 0, w: 12, h: 2, config })

async function renderBlock(b: Block, s: PublicDataSource, params = {}) {
  render(await BlockView({ block: b, source: s, params }))
}

describe('blocks', () => {
  it('text: heading + paragraphs', async () => {
    await renderBlock(block('text', { heading: 'Hello', body: 'One\n\nTwo' }), source([]))
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeTruthy()
    expect(screen.getByText('Two')).toBeTruthy()
  })

  it('record_list renders only the fields present (Review Focus #2: unpublished field is absent, no crash)', async () => {
    const s = source([{ id: '1', name: 'Chair' }]) // "unit_price" was unpublished → key omitted by Go
    await renderBlock(block('record_list', { table: 'product', fields: ['name', 'unit_price'], title_field: 'name', detail_slug: 'products' }), s)
    expect(screen.getByText('Chair')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Chair/ }).getAttribute('href')).toBe('/products/1')
  })

  it('record_list on an unpublished table renders nothing', async () => {
    const { container } = render(await BlockView({ block: block('record_list', { table: 'crm', fields: ['name'], title_field: 'name' }), source: source(null), params: {} }))
    expect(container.textContent).toBe('')
  })

  it('record_detail reads the id from the URL; unknown id renders nothing', async () => {
    const s = source([{ id: '7', name: 'Lamp' }])
    await renderBlock(block('record_detail', { table: 'product', fields: ['name'], title_field: 'name' }), s, { id: '7' })
    expect(screen.getByRole('heading', { name: 'Lamp' })).toBeTruthy()
  })

  it('event blocks render a placeholder until spec 4', async () => {
    const { container } = render(await BlockView({ block: block('event_booking', {}), source: source([]), params: {} }))
    expect(container.textContent).not.toBe('')
  })
})

describe('stackOrder (Review Focus #5)', () => {
  it('orders by row then column', () => {
    const b = (id: string, x: number, y: number): Block => ({ id, type: 'text', x, y, w: 6, h: 1, config: {} })
    expect(stackOrder([b('c', 0, 2), b('b', 6, 0), b('a', 0, 0)]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
})
```

`public-api.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { serverPublicSource } from './public-api'

beforeEach(() => { process.env.API_BASE = 'http://api.test' })
afterEach(() => vi.restoreAllMocks())

it('lists through /api/v1/public with filters, null on 404', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: '1' }], total: 1 }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const res = await serverPublicSource.list('product', { filter: { published: 'true' }, page_size: 6 })
  expect(res).toEqual({ records: [{ id: '1' }], total: 1 })
  expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.test/api/v1/public/product?page_size=6&filter%5Bpublished%5D=true')

  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
  expect(await serverPublicSource.list('crm', {})).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `rtk pnpm --filter shell vitest run src/website`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`types.ts`:

```ts
// Keep in sync with core/modules/website/validate.go BlockTypes.
export const BLOCK_TYPES = ['text', 'image', 'hero', 'record_list', 'record_detail', 'event_booking', 'appointment_booking'] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

export interface Block {
  id: string
  type: BlockType
  x: number
  y: number
  w: number
  h: number
  config: Record<string, unknown>
}

export interface TextConfig { heading?: string; body: string; align?: 'left' | 'center' | 'right' }
export interface ImageConfig { table: string; record: string; field: string; alt: string; href?: string }
export interface HeroConfig { title: string; subtitle?: string; cta_label?: string; cta_href?: string }
export interface RecordListConfig {
  table: string; fields: string[]; title_field: string; filter?: Record<string, string>
  page_size?: number; display?: 'grid' | 'list'; detail_slug?: string; picture_field?: string
}
export interface RecordDetailConfig { table: string; fields: string[]; title_field: string; picture_field?: string }

/** Where blocks read published data — the public API server-side, a Server
 * Action in the editor. null = table not published (404). */
export interface PublicDataSource {
  list(table: string, q: { filter?: Record<string, string>; page_size?: number }): Promise<{ records: Record<string, unknown>[]; total: number } | null>
  get(table: string, id: string): Promise<Record<string, unknown> | null>
}

/** Phone order: top-to-bottom, then left-to-right of the desktop grid. */
export function stackOrder(blocks: Block[]): Block[] {
  return [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)
}
```

`public-api.ts`:

```ts
import 'server-only'
import type { Block, PublicDataSource } from './types'

function base(): string {
  const api = process.env.API_BASE
  if (!api) throw new Error('API_BASE is not set')
  return `${api}/api/v${process.env.API_VERSION ?? '1'}/public`
}

async function getJSON<T>(path: string, tags: string[]): Promise<T | null> {
  const res = await fetch(base() + path, { next: { tags, revalidate: 60 } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`public API ${path}: ${res.status}`)
  return (await res.json()) as T
}

export const serverPublicSource: PublicDataSource = {
  async list(table, q) {
    const params = new URLSearchParams()
    if (q.page_size) params.set('page_size', String(q.page_size))
    for (const [k, v] of Object.entries(q.filter ?? {})) params.set(`filter[${k}]`, v)
    const qs = params.toString()
    const body = await getJSON<{ data: Record<string, unknown>[]; total: number }>(
      `/${table}${qs ? '?' + qs : ''}`, ['website_page', table])
    return body ? { records: body.data, total: body.total } : null
  },
  get: (table, id) => getJSON<Record<string, unknown>>(`/${table}/${encodeURIComponent(id)}`, ['website_page', table]),
}

/** Browser-relative: the gateway routes /api/v1/* to Go, and public pictures need no session. */
export function pictureUrl(table: string, record: string, field: string): string {
  return `/api/v1/public/${table}/${record}/picture/${field}`
}

export interface SitePage { id: string; slug: string; title: string; seo_description?: string; layout: Block[] }

export async function getSitePage(slug: string): Promise<SitePage | null> {
  const page = await serverPublicSource.list('website_page', { filter: { slug }, page_size: 1 })
  return (page?.records[0] as SitePage | undefined) ?? null
}

export async function getMenuPages(): Promise<Pick<SitePage, 'slug' | 'title'>[]> {
  const res = await serverPublicSource.list('website_page', { filter: { in_menu: 'true' }, page_size: 50 })
  return ((res?.records ?? []) as (SitePage & { menu_sequence?: number })[])
    .sort((a, b) => (a.menu_sequence ?? 0) - (b.menu_sequence ?? 0))
}
```

(The `filter[slug]` of `""` for the home page: `listFilter` skips empty values, so query the home page with `filter[slug]` unset + client-side pick of `slug === ''`, or — simpler — have `getSitePage('')` list with `page_size: 50` and pick `slug === ''`. Implement that branch.)

Block components — server components using MUI (`Typography`, `Card`, `Grid`), no client state:
- `BlockView.tsx`: `switch (block.type)` → `TextBlock`/`ImageBlock`/`HeroBlock`/`RecordListBlock`/`RecordDetailBlock`/`PendingBlock`.
- `TextBlock`: optional `<Typography variant="h4" component="h2">{heading}</Typography>`, then `body.split(/\n\s*\n/)` → `<Typography paragraph>`; `align` → `textAlign`.
- `HeroBlock`: `Box` with `py: 6`, title `h3`/`h1`-sized, subtitle, and a `Button href={cta_href}` when both CTA fields are set.
- `ImageBlock`: `<img src={pictureUrl(...)} alt={alt} style={{ maxWidth: '100%', height: 'auto' }} loading="lazy">`, wrapped in `<a href>` when `href` is set.
- `RecordListBlock`: `const res = await source.list(cfg.table, { filter: cfg.filter, page_size: cfg.page_size ?? 12 }); if (!res) return null`. Render a responsive `Grid` (`xs: 12, sm: 6, md: 4` when `display === 'grid'`, full width for `list`) of `Card`s: picture (when `picture_field` is published → `pictureUrl`), the `title_field` value as a heading, then each other field present on the record as `label: value` (label = field key with `_` → space, capitalised). Wrap the card in `CardActionArea href={`/${detail_slug}/${record.id}`}` when `detail_slug` is set. Skip fields absent from the record (Review Focus #2).
- `RecordDetailBlock`: `if (!params.id) return null; const rec = await source.get(cfg.table, params.id); if (!rec) return null` → heading + picture + fields.
- `PendingBlock`: a muted `Typography` "Booking will be available soon." (translated).
- `StackedGrid.tsx`:

```tsx
import Box from '@mui/material/Box'
import type { ReactNode } from 'react'
import { stackOrder, type Block } from '../types'

/** Desktop: the saved 12-column grid; below md: one column in (y, x) order. */
export function StackedGrid({ blocks, render }: { blocks: Block[]; render: (b: Block) => ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(12, 1fr)' }, gridAutoRows: { md: 'minmax(40px, auto)' } }}>
      {stackOrder(blocks).map((b) => (
        <Box key={b.id} sx={{ gridColumn: { md: `${b.x + 1} / span ${b.w}` }, gridRow: { md: `${b.y + 1} / span ${b.h}` }, minWidth: 0 }}>
          {render(b)}
        </Box>
      ))}
    </Box>
  )
}
```

Add every new visible string ("Booking will be available soon.", "Read more") to `shell.pot` + `fr.po`.

- [ ] **Step 4: Run to verify they pass**

Run: `rtk pnpm --filter shell vitest run src/website`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell/src/website core-front/apps/shell/i18n
rtk git commit -m "feat(website): block model, public data source and server-rendered blocks"
```

---

### Task 6: Public site routes

**Files:**
- Create: `apps/shell/app/(site)/layout.tsx`, `apps/shell/app/(site)/[[...slug]]/page.tsx`, `apps/shell/app/(site)/not-found.tsx`, `apps/shell/src/website/SiteHeader.tsx`
- Test: `apps/shell/app/(site)/[[...slug]]/page.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`getSitePage`, `getMenuPages`, `serverPublicSource`, `BlockView`, `StackedGrid`); spec 1 `getSiteIdentity()`; `getIdentity()` (ERP session).
- Produces: `/` and `/<slug>` and `/<slug>/<id>` render published pages; `generateMetadata` from `title`/`seo_description`; header with menu, "Log in"/"My account", "ERP" link (`/app`) when an ERP session exists.

- [ ] **Step 1: Write the failing test**

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const pages: Record<string, unknown> = {
  '': { id: 'h', slug: '', title: 'Home', layout: [{ id: 'a', type: 'text', x: 0, y: 0, w: 12, h: 1, config: { body: 'Welcome' } }] },
  products: { id: 'p', slug: 'products', title: 'Products', layout: [] },
}
vi.mock('@/website/public-api', () => ({
  getSitePage: async (slug: string) => pages[slug] ?? null,
  serverPublicSource: { list: async () => null, get: async () => null },
}))
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
vi.mock('next/navigation', () => ({ notFound }))

import Page, { generateMetadata } from './page'

describe('site page', () => {
  beforeEach(() => notFound.mockClear())

  it('renders the home page at /', async () => {
    render(await Page({ params: Promise.resolve({}) }))
    expect(screen.getByText('Welcome')).toBeTruthy()
  })

  it('404s an unknown slug', async () => {
    await expect(Page({ params: Promise.resolve({ slug: ['nope'] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s more than two segments', async () => {
    await expect(Page({ params: Promise.resolve({ slug: ['products', '1', 'x'] }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('metadata comes from the page', async () => {
    expect((await generateMetadata({ params: Promise.resolve({ slug: ['products'] }) })).title).toBe('Products')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk pnpm --filter shell vitest run "app/(site)"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`[[...slug]]/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Container from '@mui/material/Container'
import { getSitePage, serverPublicSource } from '@/website/public-api'
import { BlockView } from '@/website/blocks/BlockView'
import { StackedGrid } from '@/website/blocks/StackedGrid'

type Props = { params: Promise<{ slug?: string[] }> }

// "/" → home (slug ""), "/<slug>" → page, "/<slug>/<id>" → page with a
// record id for its record_detail blocks.
async function resolve(params: Props['params']) {
  const { slug = [] } = await params
  if (slug.length > 2) return null
  const page = await getSitePage(slug[0] ?? '')
  return page ? { page, id: slug[1] } : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolve(params)
  return r ? { title: r.page.title, description: r.page.seo_description } : {}
}

export default async function SitePage({ params }: Props) {
  const r = await resolve(params)
  if (!r) notFound()
  const blocks = await Promise.all(
    r.page.layout.map(async (b) => [b.id, await BlockView({ block: b, source: serverPublicSource, params: { id: r.id } })] as const),
  )
  const rendered = new Map(blocks)
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <StackedGrid blocks={r.page.layout} render={(b) => rendered.get(b.id)} />
    </Container>
  )
}
```

`(site)/layout.tsx`: server component → `const [menu, siteUser, erpUser] = await Promise.all([getMenuPages(), getSiteIdentity(), getIdentity()])`, renders `<SiteHeader menu={menu} signedIn={!!siteUser} staff={!!erpUser} />`, `<main>{children}</main>`, and a simple footer. `SiteHeader`: MUI `AppBar position="static"` with links `/` + each `/${slug}`, right side `Log in` (`/login`) or `My account` (`/account`), and `ERP` (`/app`) when `staff`. Use `<T>` for labels; on phones collapse the menu into a `Menu` behind an icon button (MUI `IconButton` + `Menu`), no horizontal scroll.

`(site)/not-found.tsx`: "Page not found" + link home.

- [ ] **Step 4: Run to verify it passes; typecheck**

Run: `rtk pnpm --filter shell vitest run "app/(site)"` and `rtk tsc --noEmit -p core-front/apps/shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add "core-front/apps/shell/app/(site)" core-front/apps/shell/src/website core-front/apps/shell/i18n
rtk git commit -m "feat(website): public site routes render published pages server-side"
```

---

### Task 7: Website app in the ERP — descriptors and settings pages

**Files:**
- Modify: `core/modules/website/views/WebsiteViews.ts` (scaffold name — keep it), its test
- Create: `apps/shell/app/app/settings/website/page.tsx` (hub), `.../website/published/page.tsx` + `PublishedDataForm.tsx`, `.../website/routing/page.tsx` + `RoutingForm.tsx`, `.../website/users/page.tsx` + `WebsiteUsersTable.tsx`, `apps/shell/src/lib/website-settings.ts` (server actions)
- Modify: `apps/shell/app/app/settings/SettingsHub.tsx` (`SETTINGS_SECTIONS` + Website)
- Test: `core/modules/website/views/WebsiteViews.test.ts`, `apps/shell/src/lib/website-settings.test.ts`

**Interfaces:**
- Consumes: Go `GET /api/v1/settings/website/public`, `PUT …/public/:table`, `GET|PUT …/website/routing`, `GET /api/v1/website_admin/users`, `PUT …/users/:id`.
- Produces: FrontModule `website` with routes `/website` (dashboard), `/website/pages` (tree), `/website/pages/:id` (form, header button `website.design` → `window.location.assign(erpPath(\`/website/pages/${id}/design\`))`); server actions `getPublished()`, `savePublished(table, sel)`, `getRouting()`, `saveRouting(r)` (sends header `X-EERP-Request-Host` from `headers().get('host')`), `listWebsiteUsers()`, `updateWebsiteUser(id, patch)`.

- [ ] **Step 1: Write the failing tests**

`WebsiteViews.test.ts` — mirror the scaffold's own test and assert:

```ts
import { describe, expect, it } from 'vitest'
import websiteModule from './WebsiteViews'

describe('website views', () => {
  it('registers the pages list and form with a Design button', () => {
    const paths = websiteModule.routes.map((r) => r.path)
    expect(paths).toEqual(expect.arrayContaining(['/website', '/website/pages', '/website/pages/:id']))
    const form = websiteModule.routes.find((r) => r.path === '/website/pages/:id')!.descriptor
    expect(form.entity).toBe('website_page')
    expect(form.headerButtons?.map((b) => b.name)).toContain('website.design')
    expect(form.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['title', 'slug', 'published', 'in_menu', 'menu_sequence', 'seo_description']))
  })
})
```

`website-settings.test.ts` — mock `next/headers` (`headers()` returning `host: erp.acme.fr`, `cookies()` as in the auth route tests) and `fetch`, then assert `saveRouting({ mode: 'host', site_host: 'www.acme.fr', erp_host: 'erp.acme.fr' })` PUTs `/api/v1/settings/website/routing` with header `X-EERP-Request-Host: erp.acme.fr` and the bearer token from the ERP cookie. Use `createServerApiClient()` if it can take extra headers; otherwise a direct `fetch` with the access cookie (read how `settings-actions.ts` issues PUTs and follow it).

- [ ] **Step 2: Run to verify they fail**

Run: `rtk pnpm --filter @eerp/website vitest run` (package name from the scaffold's `package.json`) and `rtk pnpm --filter shell vitest run src/lib/website-settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`WebsiteViews.ts` — follow `crm_views.ts` for shape. Fields: `title` (text, required), `slug` (text, help "Empty = home page. Lowercase letters, digits, dashes."), `published` (boolean switch), `in_menu` (boolean), `menu_sequence` (number int), `seo_description` (text long). List view: title, slug, published, in_menu. Register the Design button:

```ts
registerHeaderButtonAction({
  entity: 'website_page',
  name: 'website.design',
  handler: (ctx) => {
    window.location.assign(erpPath(`/website/pages/${ctx.recordId}/design`))
  },
})
```

with `headerButtons: [{ name: 'website.design', label: 'Design', states: { visible: { field: 'id', op: 'set' } } }]` on the form (check `Condition` supports `set` on `id`; otherwise omit `states`). Dashboard view like CRM's. Import `erpPath` from `@eerp/core-front`.

Settings pages (client forms inside server pages, `requireAuth('/settings/website/…')`):
- **Published data** — one card per table from `getPublished()`: checkboxes for each declared field (checked = published), and "Only rows where" filter pairs (column + value text inputs, add/remove). Save per table → `savePublished`. Show Go's 400 message inline on failure.
- **Routing** — radio `path`/`host`; host fields when `host`; a warning `Alert` explaining the lockout guard ("Save this from the ERP address you are entering, e.g. https://erp.example.com/app/settings/website/routing") and the env override `EERP_SITE_ROUTING=path`; show Go's 400 message.
- **Website users** — MUI table: email, name, created, verified, disabled switch (→ `updateWebsiteUser(id, { disabled })`), inline edit of name/phone.

`SETTINGS_SECTIONS`: add `{ path: '/settings/website', title: 'Website', description: 'Published data, routing and website accounts.' }`. Hub page `/settings/website` lists the three subpages.

Translations for every label into `shell.pot`/`fr.po` (and the module's own `i18n/website.pot` + `fr.po` for descriptor labels, per the module i18n convention).

- [ ] **Step 4: Run to verify they pass; typecheck; smoke**

Run: the two test commands, `rtk tsc --noEmit -p core-front/apps/shell`; then manually: `/app/website/pages` lists pages, the form saves, Settings → Website pages load.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/modules/website core-front/apps/shell
rtk git commit -m "feat(website): Website app (pages) and Settings → Website (published data, routing, users)"
```

---

### Task 8: The page editor (drag, resize, configure, live preview)

**Files:**
- Create: `apps/shell/app/app/website/pages/[id]/design/page.tsx`, `.../design/PageEditor.tsx` (client), `.../design/BlockPalette.tsx`, `.../design/BlockSettings.tsx`, `apps/shell/src/website/editor-actions.ts` (server actions), `apps/shell/src/website/layout-ops.ts` (pure layout helpers)
- Test: `apps/shell/src/website/layout-ops.test.ts`, `.../design/PageEditor.test.tsx`

**Interfaces:**
- Consumes: Task 5 components + types; spec 1 `GET /api/v1/settings/website/public` (via `getPublished()` from Task 7); `updateRecord('website_page', id, { layout })` from `app/app/[...module]/actions`.
- Produces: `layout-ops.ts`: `addBlock(layout: Block[], type: BlockType): Block[]` (new id `b-<random>`, placed at `x: 0, y: max(y+h)`, default size per type: text 12×2, hero 12×4, image 6×4, record_list 12×6, record_detail 12×6, bookings 12×6; default config per type), `removeBlock(layout, id)`, `applyGeometry(layout, rgl: { i: string; x: number; y: number; w: number; h: number }[]): Block[]`, `updateConfig(layout, id, config)`; server actions `previewBlock(block: Block, params: { id?: string }): Promise<ReactNode>` — renders `BlockView` with `serverPublicSource` (a Server Action returning RSC — if the Next version in use can't return JSX from an action, instead expose `previewData(table, q)` returning records and render the block client-side through a `clientSource` adapter; decide by trying the first, keep whichever passes the test).

- [ ] **Step 1: Write the failing tests**

`layout-ops.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { addBlock, applyGeometry, removeBlock, updateConfig } from './layout-ops'

describe('layout ops', () => {
  it('adds below the lowest block with the type defaults', () => {
    const one = addBlock([], 'text')
    const two = addBlock(one, 'record_list')
    expect(two[1]).toMatchObject({ type: 'record_list', x: 0, y: 2, w: 12, h: 6 })
    expect(new Set(two.map((b) => b.id)).size).toBe(2)
  })
  it('applies drag/resize geometry by id and ignores unknown ids', () => {
    const l = addBlock([], 'text')
    const moved = applyGeometry(l, [{ i: l[0].id, x: 3, y: 1, w: 6, h: 3 }, { i: 'ghost', x: 0, y: 0, w: 1, h: 1 }])
    expect(moved).toEqual([{ ...l[0], x: 3, y: 1, w: 6, h: 3 }])
  })
  it('removes and reconfigures', () => {
    const l = addBlock(addBlock([], 'text'), 'hero')
    expect(removeBlock(l, l[0].id).map((b) => b.id)).toEqual([l[1].id])
    expect(updateConfig(l, l[1].id, { title: 'Hi' })[1].config).toEqual({ title: 'Hi' })
  })
})
```

`PageEditor.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const phone = vi.hoisted(() => ({ value: false }))
vi.mock('@mui/material/useMediaQuery', () => ({ default: () => phone.value }))
vi.mock('@/website/editor-actions', () => ({ previewBlock: async () => null }))

import { PageEditor } from './PageEditor'
import type { Block } from '@/website/types'

const published = [
  { table: 'product', declared: ['name', 'unit_price', 'reference'], fields: ['name', 'unit_price'], filter: {} },
  { table: 'company', declared: ['name'], fields: [], filter: {} },
]
const layout: Block[] = [
  { id: 'b-2', type: 'text', x: 0, y: 4, w: 12, h: 2, config: { body: 'second' } },
  { id: 'b-1', type: 'record_list', x: 0, y: 0, w: 12, h: 4, config: { table: '', fields: [], title_field: '' } },
]

function setup() {
  const save = vi.fn(async () => null)
  render(<PageEditor pageId="p1" slug="home" title="Home" layout={layout} published={published} save={save} />)
  return save
}

describe('PageEditor', () => {
  it('adds a block from the palette', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /add block/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /text/i }))
    expect(screen.getAllByTestId(/^editor-block-/)).toHaveLength(3)
  })

  it('record_list settings offer only published tables and published fields', () => {
    setup()
    fireEvent.click(screen.getByTestId('editor-block-b-1'))
    const panel = screen.getByTestId('block-settings')
    fireEvent.mouseDown(within(panel).getByLabelText(/table/i))
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['product']) // company publishes no field
    fireEvent.click(screen.getByRole('option', { name: 'product' }))
    expect(within(panel).getByRole('checkbox', { name: 'name' })).toBeTruthy()
    expect(within(panel).queryByRole('checkbox', { name: 'reference' })).toBeNull() // declared, not published
  })

  it('saves the current layout', async () => {
    const save = setup()
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'b-1' })])))
  })

  it('stacks blocks in (y, x) order on phones (Review Focus #5)', () => {
    phone.value = true
    setup()
    expect(screen.getAllByTestId(/^editor-block-/).map((e) => e.dataset.testid)).toEqual(['editor-block-b-1', 'editor-block-b-2'])
    phone.value = false
  })
})
```

Give each canvas block `data-testid={`editor-block-${b.id}`}` and the settings panel `data-testid="block-settings"`; on phones render the canvas as a `Stack` in `stackOrder()` instead of `ReactGridLayout` (the same projection Graph mode uses).

- [ ] **Step 2: Run to verify they fail**

Run: `rtk pnpm --filter shell vitest run src/website/layout-ops.test.ts "app/app/website"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`layout-ops.ts` — pure functions exactly per the interface (default configs: text `{ body: '' }`, hero `{ title: '' }`, image `{ table: '', record: '', field: '', alt: '' }`, record_list `{ table: '', fields: [], title_field: '', display: 'grid', page_size: 12 }`, record_detail `{ table: '', fields: [], title_field: '' }`, bookings `{}`); ids from `crypto.randomUUID().slice(0, 8)` prefixed `b-`.

`design/page.tsx` (server): `await requireAuth('/website/pages/' + id + '/design')`; load the record with `createServerApiClient().get('website_page', id)` (404 → `notFound()`), load `getPublished()`; render `<PageEditor pageId title layout published save={saveLayout.bind(null, id)} />` where `saveLayout` is a server action calling `updateRecord('website_page', id, { layout })` and returning Go's error message on failure.

`PageEditor.tsx` (client) — follow `graph-renderer.tsx`'s grid wiring:

```tsx
const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })
...
<ReactGridLayout
  layout={layout.map((b) => ({ i: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))}
  width={width}
  gridConfig={{ cols: 12, rowHeight: 40, margin: [8, 8], containerPadding: [0, 0] }}
  dragConfig={{ enabled: !phone, cancel: '.block-no-drag' }}
  resizeConfig={{ enabled: !phone, handles: ['se', 'e', 's'] }}
  compactor={verticalCompactor}
  onLayoutChange={(rgl) => setLayout((l) => applyGeometry(l, rgl))}
>
  {layout.map((b) => (
    <Box key={b.id} onClick={() => setSelected(b.id)} sx={{ outline: selected === b.id ? 2 : 0, outlineColor: 'primary.main', overflow: 'hidden' }}>
      <BlockPreview block={b} />
    </Box>
  ))}
</ReactGridLayout>
```

Layout: top toolbar (page title, "Add block" menu = `BlockPalette`, "Save", "View on site" → `/${slug}` in a new tab, "Back" → `erpPath('/website/pages/' + id)`); canvas left; `BlockSettings` right panel (`Drawer variant="permanent"` ≥ md, bottom `Drawer` on phones) with per-type forms: text (heading, body multiline, align), hero (title, subtitle, CTA label/href), image (table select, record id, field select of published picture-capable fields, alt, link), record_list (table select, field checkboxes, title field select, display, page size, detail slug, picture field, filter pairs), record_detail (table, fields, title field, picture field), bookings (event id — spec 4 fills it). A "Delete block" button. Unsaved-changes guard: `beforeunload` while dirty.

`BlockPreview`: debounced (300 ms) call to the preview server action keyed by block JSON, showing a skeleton while loading — this is the live preview: the same `BlockView` the public site renders, over the same public data.

Translations for every label into `shell.pot` + `fr.po`.

- [ ] **Step 4: Run to verify; typecheck; smoke**

Run: the Step 2 command, `rtk tsc --noEmit -p core-front/apps/shell`. Manual: create a page, open Design, add a text block + a product list, drag/resize, save, "View on site" shows the same thing; phone-width browser shows one column.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell
rtk git commit -m "feat(website): drag-and-drop page editor with live preview"
```

---

### Task 9: Site account pages and host-mode routing

**Files:**
- Create: `apps/shell/app/(site)/login/page.tsx`, `(site)/signup/page.tsx`, `(site)/account/page.tsx`, `apps/shell/src/website/SiteAuthForm.tsx`
- Modify: `apps/shell/src/lib/routing.ts` (+ tests), `apps/shell/proxy.ts` (+ `proxy.test.ts`)

**Interfaces:**
- Consumes: spec 1 BFF routes `/api/site-auth/{login,signup,logout,refresh}`, `getSiteIdentity`, Go `GET /api/v1/website/me` (via a server action using the site access cookie); Task 3 `GET /api/v1/public/site`.
- Produces: `/login`, `/signup`, `/account` site pages; `routeDecision` host mode; proxy fetches the routing (cached 60 s in-process, `EERP_SITE_ROUTING=path` override) and proactively refreshes the SITE session like it does the ERP one.

- [ ] **Step 1: Write the failing tests** — extend `routing.test.ts`:

```ts
describe('routeDecision — host mode', () => {
  const routing = { mode: 'host' as const, site_host: 'www.acme.fr', erp_host: 'erp.acme.fr' }
  it.each([
    ['www.acme.fr', '/', { kind: 'next' }],
    ['www.acme.fr', '/products', { kind: 'next' }],
    ['www.acme.fr', '/app/crm', { kind: 'redirect', location: 'https://erp.acme.fr/app/crm' }],
    ['www.acme.fr', '/crm/1', { kind: 'redirect', location: 'https://erp.acme.fr/app/crm/1' }],
    ['erp.acme.fr', '/', { kind: 'redirect', location: '/app' }],
    ['erp.acme.fr', '/app/crm', { kind: 'next' }],
    ['erp.acme.fr', '/products', { kind: 'redirect', location: 'https://www.acme.fr/products' }],
    ['erp.acme.fr', '/api/v1/public/site', { kind: 'next' }],
    ['erp.acme.fr:443', '/app', { kind: 'next' }],
    // Unknown host (IP, localhost): behave like path mode so admins are never locked out.
    ['10.0.0.5', '/app/crm', { kind: 'next' }],
    ['10.0.0.5', '/', { kind: 'next' }],
  ])('%s %s', (host, pathname, want) => {
    expect(routeDecision({ pathname, host, erpRoots, routing })).toEqual(want)
  })
})
```

`proxy.test.ts` — add: with `process.env.EERP_SITE_ROUTING = 'path'` and Go answering host mode, a request to `http://www.acme.fr/app/crm` is NOT redirected; with no override it is (mock `fetch` for `/api/v1/public/site`; reset the proxy's routing cache between tests via an exported `resetRoutingCache()`).

Site auth: `SiteAuthForm.test.tsx` — submitting login POSTs `/api/site-auth/login` and navigates to `/account`; a 401 shows the message; signup validates password length ≥ 8 client-side before posting.

- [ ] **Step 2: Run to verify they fail**

Run: `rtk pnpm --filter shell vitest run src/lib/routing.test.ts proxy.test.ts src/website`
Expected: FAIL.

- [ ] **Step 3: Implement**

`routeDecision` host branch (before the path-mode logic):

```ts
  const r = input.routing
  if (r.mode === 'host' && r.site_host && r.erp_host) {
    const host = input.host.replace(/:\d+$/, '').toLowerCase()
    const isErpPath = first === 'app' || input.erpRoots.has(first)
    if (host === r.site_host && isErpPath) {
      const p = first === 'app' ? input.pathname : '/app' + input.pathname
      return { kind: 'redirect', location: `https://${r.erp_host}${p}` }
    }
    if (host === r.erp_host) {
      if (input.pathname === '/') return { kind: 'redirect', location: '/app' }
      if (!ROOT_PASSTHROUGH.has(first) && !isErpPath) {
        return { kind: 'redirect', location: `https://${r.site_host}${input.pathname}` }
      }
      return { kind: 'next' }
    }
    // Any other host (IP, localhost, internal name) falls through to path mode.
  }
```

Delta vs spec: on `erp_host` the ERP stays under `/app` (`/` redirects there) rather than being rewritten to the root — no per-link rewriting, and `/app/...` URLs are identical on both hosts.

`proxy.ts`: module-scope cache `{ value: Routing; at: number } | null`; `async function currentRouting()` returns `{ mode: 'path' }` when `process.env.EERP_SITE_ROUTING === 'path'`, else the cached value if younger than 60 s, else `fetch(${API_BASE}/api/v${v}/public/site, { cache: 'no-store' })` → `.routing` (any failure → `{ mode: 'path' }`, cached for 60 s too). Host from `request.headers.get('x-forwarded-host') ?? request.headers.get('host')`. Redirects use 307 for cross-host (method-preserving, not cached by browsers — a routing change takes effect immediately) and 308 for the bare-ERP-path redirect. Export `resetRoutingCache()` for tests.

Site-session refresh: after the existing ERP refresh block, the same pattern for `SITE_ACCESS_COOKIE`/`SITE_REFRESH_COOKIE` with `goAuthExchange('refresh', { refresh_token }, 'website/auth')` — factor the existing block into `refreshSession(request, response, { access, refresh, base })` and call it twice.

Site pages: `/login` and `/signup` render `SiteAuthForm mode="login"|"signup"` (client; `fetch('/api/site-auth/…')`, then `router.push('/account')` + `router.refresh()`); `/account` (server) → `getSiteIdentity()` or `redirect('/login?next=/account')`, shows the profile from `GET /api/v1/website/me` (server-side fetch with the site access cookie as bearer), an edit form (name, surname, phone → server action `PUT /api/v1/website/me`), a "Log out" button (POST `/api/site-auth/logout`), and a "My bookings" section placeholder that spec 4 fills.

- [ ] **Step 4: Run to verify; typecheck; smoke**

Run: Step 2 command + `rtk tsc --noEmit -p core-front/apps/shell`. Manual: sign up at `/signup`, land on `/account`, edit name, log out, log in.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front/apps/shell
rtk git commit -m "feat(website): visitor login/signup/account pages; host-based routing in the proxy"
```

---

### Task 10: nginx certificates and documentation

**Files:**
- Modify: `infra/nginx/gen-certs.sh`, `compose.yml` (`gateway-certs` env), `infra/nginx/nginx.conf` (only if `X-Forwarded-Host` is missing on the Next upstream)
- Create: `infra/nginx/README.md`
- Modify: `CLAUDE.md`, `core-front/CLAUDE.md`, `docs/superpowers/specs/2026-09-29-website-2-core-design.md`; create `docs/adr/ADR-025-website-routing-and-erp-base-path.md`

- [ ] **Step 1: Certificates**

`gen-certs.sh`: build the SAN list from `SITE_HOST`/`ERP_HOST` when set:

```sh
SAN="DNS:localhost,DNS:api-gateway,IP:127.0.0.1"
[ -n "${SITE_HOST:-}" ] && SAN="$SAN,DNS:$SITE_HOST"
[ -n "${ERP_HOST:-}" ] && SAN="$SAN,DNS:$ERP_HOST"
...
  -addext "subjectAltName=$SAN"
```

`compose.yml` `gateway-certs.environment`: `SITE_HOST: ${SITE_HOST:-}`, `ERP_HOST: ${ERP_HOST:-}`. Check `nginx.conf`'s `location /` (Next upstream) sets `proxy_set_header X-Forwarded-Host $host;` — add it if absent.

Verify: `rtk docker compose run --rm -e SITE_HOST=www.test -e ERP_HOST=erp.test gateway-certs` after clearing the volume, then `openssl x509 -in … -noout -ext subjectAltName` lists both names.

- [ ] **Step 2: `infra/nginx/README.md`** — why the gateway exists (TLS + HTTP/2), the dev cert and how to regenerate it (clear `gateway-certs`), host mode: DNS A/AAAA for both hosts, then either mount your own cert/key as `gateway.crt`/`gateway.key` into the volume or run certbot webroot (`/.well-known/acme-challenge/` served on :80 before the HTTPS redirect — add that `location` to the :80 server if you document certbot), and the recovery override `EERP_SITE_ROUTING=path`.

- [ ] **Step 3: ADR-025 + CLAUDE.md**

ADR-025 records: site at `/`, ERP at `/app` via link-time `erpPath()` (not by rewriting registry/descriptor paths — why: descriptors, formPaths and extensions stay module-relative, one choke point, idempotent); `/print`, `/api`, `/database` stay at the root; host mode = redirects, not rewrites; lockout guard + env override; bare ERP paths 308 → `/app/…`.

Root `CLAUDE.md`: a `core/modules/website` bullet (pages, block validation middleware, public declaration, routing setting, public picture route). `core-front/CLAUDE.md`: rows for "ERP base path (`erpPath`)", "Public site (`app/(site)`, `src/website/blocks`)", "Page editor". Spec 2: record the deltas (plain-text text block, image block anchored on a record field, `erp_host` keeps `/app`, no sort on record lists).

- [ ] **Step 4: Full verification**

Run: `rtk make run-back-tests`, `rtk pnpm -r vitest run`, `rtk tsc --noEmit -p core-front/apps/shell`, (from `core/`) `rtk golangci-lint run ./...`
Expected: all PASS / clean.

- [ ] **Step 5: Commit**

```bash
rtk git add infra compose.yml CLAUDE.md core-front/CLAUDE.md docs
rtk git commit -m "docs(website): ADR-025 routing and /app base path; gateway cert SANs"
```
