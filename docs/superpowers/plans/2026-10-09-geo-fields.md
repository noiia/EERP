# Geographic Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Geographic point and zone fields on any ORM entity, with distance, radius, nearest-first and point-in-zone answered by PostGIS, a Leaflet map widget, a distance widget, search-bar geo filters, and the website's "nearest events".

**Architecture:** PostGIS `geography` columns. The ORM moves geometries as text (EWKB hex out, EWKT in) and speaks GeoJSON on the wire — no pgx codec, no SQL rewriting. The generic list endpoint gains `near`/`within`/`covers`/`inside` params; record references (`table:id:col`) are resolved inside `core/orm/internal/crud` behind a per-request read check the permission middleware stamps on the context. The frontend adds field types `geo` (widgets `point`, `shape`) and `distance` (widget `meters`).

**Tech Stack:** Go 1.26, pgx v5, PostGIS 3.6 on Postgres 18, `github.com/twpayne/go-geom`; Next 16 / React 19 / MUI, `leaflet` 1.9, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-geo-fields-design.md`

## Global Constraints

- DB image: `postgis/postgis:18-3.6` everywhere Postgres runs (compose, CI).
- SRID 4326 only; SQL types `geography(Point,4326)` (point) and `geography(Geometry,4326)` (shape).
- Wire format: a GeoJSON **geometry object** (not a Feature). Coordinates are `[lon, lat]`.
- Allowed kinds: point column → `Point`; shape column → `Polygon`, `MultiPolygon`, `LineString`.
- Limits: lon ∈ [-180, 180], lat ∈ [-90, 90], 2D only, ≤ 10 000 positions, polygon rings closed with ≥ 4 positions, LineString ≥ 2 positions; radius 0 < m ≤ 20 000 000.
- Invalid geometry in a write → **422** `VALIDATION_ERROR` with the field in `fields`. Malformed geo list param → **400**. Unresolvable reference (unknown/excluded/unreadable table, non-shape column, gated column) → **404**. A missing record or other tenant's record matches nothing (no error).
- Computed response key: `_distance_m` (read-only, only with `near`). Public events: `distance_m`.
- New columns are always nullable; ERP code imports only the `core/orm` facade (`orm.GeoPoint`, `orm.GeoShape`), never `core/orm/geo` directly — except inside `core/orm`.
- Go: no `fmt`/`log` direct output in production code paths beyond what the package already uses (depguard); search with `rg`, never `grep`; prefix shell commands with `rtk`.
- Frontend: descriptors stay JSON-serializable; Leaflet is imported only client-side (dynamic `import('leaflet')` inside effects); markers are `L.divIcon` (no image assets).
- Tests touching the DB seed under a fresh `uuid.New()` tenant and delete only their rows; test-only tables may be dropped by their own test.
- Commits: `<type>(scope): <description>` ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; identity `git -c user.name=noiia -c user.email=edwin.lecomte31@gmail.com`.
- Go on this machine: `export PATH=$PATH:/usr/local/go/bin`; DB tests need `CONFIG=/home/noia/development/EERP/eerp-config.json`; pnpm is `npx -y pnpm@12.4.2`; rebuild the engine (`npx -y pnpm@12.4.2 build` in `core-front/packages/core-front`) before running shell tests that use new engine exports.

## Review Focus

1. **An existing database (dev/prod) gets the extension on the next boot** — a DB created before this change has no `postgis`; boot must create it before the first geography column, and `testdb.Migrate` on a fresh CI DB must too. Pinned by Task 1's test on `EnsureSchema`.
2. **A record with no location** — `near` must still list it (last, `_distance_m: null`), the distance widget must show "—", the map must render empty without throwing. Pinned in Tasks 4, 7, 10, 11.
3. **Clearing a location** (`null` in a PUT) must store NULL, not fail validation. Pinned in Task 3.
4. **Antimeridian / pole coordinates** (lon ±180, lat ±90) are valid input and must round-trip. Pinned in Task 2's table.
5. **Visitor refuses geolocation** on the website — the event list must stay in its soonest-first order, no error shown. Pinned in Task 13.

---

### Task 1: PostGIS image and extension at boot

**Files:**
- Modify: `compose.yml:3` (db image)
- Modify: `.github/workflows/test-check.yml:14` (CI service image)
- Modify: `compose.prod.yml` (db comment)
- Modify: `core/internal/module/migration.go` (new `ensureExtensions`, called from `ensureSchema`)
- Modify: `core/internal/module/runtime.go:117-123` (`bootLocked` calls `ensureExtensions` first)
- Test: `core/internal/module/extension_test.go` (create)

**Interfaces:**
- Produces: `func ensureExtensions(ctx context.Context, db orm.Executor) error` (package `module`), run under the schema lock by every DDL entry point.

- [ ] **Step 1: Write the failing test**

```go
// core/internal/module/extension_test.go
package module_test

import (
	"context"
	"testing"

	"core/internal/testdb"
)

// EnsureSchema (what testdb.Migrate and boot share) must leave PostGIS
// installed, so a fresh database — CI, a dbmanage-created one — can hold
// geography columns.
func TestEnsureSchema_CreatesPostGIS(t *testing.T) {
	app := testdb.Open(t)
	testdb.Migrate(t, app) // no tables: only the extension pass runs
	var version string
	if err := app.DB.QueryRow(context.Background(), `SELECT postgis_version()`).Scan(&version); err != nil {
		t.Fatalf("postgis not installed: %v", err)
	}
}
```

- [ ] **Step 2: Switch the dev DB to the PostGIS image and run the test**

`compose.yml` line 3: `image: postgres:18` → `image: postgis/postgis:18-3.6`. Same for `.github/workflows/test-check.yml` line 14. Then:

Run: `rtk docker compose up -d --wait db && cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -run TestEnsureSchema_CreatesPostGIS ./internal/module/`
Expected: FAIL — `function postgis_version() does not exist`.

- [ ] **Step 3: Implement `ensureExtensions`**

In `core/internal/module/migration.go`, add above `EnsureSchema`:

```go
// ensureExtensions installs the Postgres extensions the ORM's column types
// need — today PostGIS, for orm.GeoPoint/orm.GeoShape geography columns.
// Idempotent, and run under the schema lock by every DDL entry point (boot,
// EnsureSchema, MigrateModules), so a database created before geo fields
// existed — or a brand-new one from internal/dbmanage — gets it before its
// first geography column. Needs a role allowed to create extensions (the
// compose `postgres` superuser); on a managed database, have an admin run
// CREATE EXTENSION postgis once.
func ensureExtensions(ctx context.Context, db orm.Executor) error {
	if _, err := db.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS postgis`); err != nil {
		return fmt.Errorf("create extension postgis: %w", err)
	}
	return nil
}
```

and make `ensureSchema` start with it:

```go
func ensureSchema(ctx context.Context, db orm.Executor, tables ...string) error {
	if err := ensureExtensions(ctx, db); err != nil {
		return err
	}
	for _, table := range tables {
```

In `core/internal/module/runtime.go` `bootLocked`, before `bootstrapMigrationsTable`:

```go
	if err := ensureExtensions(ctx, r.db); err != nil {
		return []error{err}
	}
```

In `compose.prod.yml`, append to the `db:` comment block:

```yaml
    # The image is postgis/postgis:18-3.6 (inherited from compose.yml): Postgres 18
    # plus PostGIS, same data directory format, so the existing volume is reused —
    # pull and recreate the container; core-back creates the extension at boot.
```

- [ ] **Step 4: Run the test and the module package**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 ./internal/module/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add compose.yml compose.prod.yml .github/workflows/test-check.yml core/internal/module/migration.go core/internal/module/runtime.go core/internal/module/extension_test.go
rtk git commit -m "feat(db): PostGIS image and extension created at boot"
```

---

### Task 2: `core/orm/geo` — types, conversions, validation

**Files:**
- Create: `core/orm/geo/geo.go`
- Create: `core/orm/geo/geo_test.go`
- Modify: `core/go.mod` / `core/go.sum` (`go get github.com/twpayne/go-geom@latest`)
- Modify: `core/orm/orm.go` (re-exports)
- Modify: `core/orm/migrate.go:91-104` (`reflectTypeToSQL`)
- Test: `core/orm/migrate_test.go` (append)

**Interfaces:**
- Produces (package `geo`):
  - `type Point struct{ Lon, Lat float64 }` — `Value() (driver.Value, error)`, `(*Point) Scan(src any) error`, `MarshalJSON`, `UnmarshalJSON` (GeoJSON Point).
  - `type Shape struct{ GeoJSON json.RawMessage }` — `Value`, `Scan`, `MarshalJSON`, `UnmarshalJSON`.
  - `type Kind int` with `KindNone`, `KindPoint`, `KindShape`; `func (k Kind) String() string`.
  - `func KindOfGoType(goType string) Kind` — `"*geo.Point"`/`"geo.Point"` → `KindPoint`, `"*geo.Shape"`/`"geo.Shape"` → `KindShape`.
  - `func EWKTFromGeoJSON(kind Kind, raw []byte) (string, error)` — validates; errors wrap `ErrInvalid`.
  - `func GeoJSONFromDB(src any) (json.RawMessage, error)` — `src` is what pgx returns for a geography column (hex EWKB text, as `string` or `[]byte`; raw binary EWKB also accepted).
  - `func ParseLonLat(s string) (lon, lat float64, err error)` — `"2.35,48.85"`.
  - `func ParseRadius(s string) (float64, error)` — meters, (0, 20 000 000].
  - `func PointSQL(lon, lat float64) string` — `ST_SetSRID(ST_MakePoint(2.35, 48.85), 4326)::geography`, numbers re-formatted (never raw input).
  - `var ErrInvalid`; consts `SRID = 4326`, `MaxPositions = 10000`.
- Produces (facade `core/orm`): `type GeoPoint = geo.Point`, `type GeoShape = geo.Shape`.

- [ ] **Step 1: Add the dependency**

Run: `cd core && go get github.com/twpayne/go-geom@latest && go mod tidy`
Expected: `go.mod` gains `github.com/twpayne/go-geom`.

- [ ] **Step 2: Write the failing tests**

```go
// core/orm/geo/geo_test.go
package geo_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"core/orm/geo"
)

func TestEWKTFromGeoJSON(t *testing.T) {
	square := `{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}`
	tests := []struct {
		name string
		kind geo.Kind
		in   string
		want string // "" = expect ErrInvalid
	}{
		{"point", geo.KindPoint, `{"type":"Point","coordinates":[2.35,48.85]}`, "SRID=4326;POINT (2.35 48.85)"},
		{"antimeridian and pole", geo.KindPoint, `{"type":"Point","coordinates":[180,-90]}`, "SRID=4326;POINT (180 -90)"},
		{"polygon", geo.KindShape, square, "SRID=4326;POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))"},
		{"linestring", geo.KindShape, `{"type":"LineString","coordinates":[[0,0],[1,1]]}`, "SRID=4326;LINESTRING (0 0, 1 1)"},
		{"multipolygon", geo.KindShape, `{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]]]}`, "SRID=4326;MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))"},
		{"point into a shape column", geo.KindShape, `{"type":"Point","coordinates":[0,0]}`, ""},
		{"polygon into a point column", geo.KindPoint, square, ""},
		{"longitude out of range", geo.KindPoint, `{"type":"Point","coordinates":[181,0]}`, ""},
		{"latitude out of range", geo.KindPoint, `{"type":"Point","coordinates":[0,90.5]}`, ""},
		{"3D refused", geo.KindPoint, `{"type":"Point","coordinates":[0,0,10]}`, ""},
		{"open ring", geo.KindShape, `{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}`, ""},
		{"short ring", geo.KindShape, `{"type":"Polygon","coordinates":[[[0,0],[1,0],[0,0]]]}`, ""},
		{"one-point line", geo.KindShape, `{"type":"LineString","coordinates":[[0,0]]}`, ""},
		{"not json", geo.KindPoint, `nope`, ""},
		{"feature, not geometry", geo.KindPoint, `{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]}}`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := geo.EWKTFromGeoJSON(tt.kind, []byte(tt.in))
			if tt.want == "" {
				if !errors.Is(err, geo.ErrInvalid) {
					t.Fatalf("err = %v, want ErrInvalid (got %q)", err, got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("got %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestEWKTFromGeoJSON_TooManyPositions(t *testing.T) {
	coords := make([]string, 0, geo.MaxPositions+1)
	for i := 0; i < geo.MaxPositions+1; i++ {
		coords = append(coords, "[0,0]")
	}
	in := `{"type":"LineString","coordinates":[` + strings.Join(coords, ",") + `]}`
	if _, err := geo.EWKTFromGeoJSON(geo.KindShape, []byte(in)); !errors.Is(err, geo.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

// 0101000020E6100000CDCCCCCCCCCC0240CDCCCCCCCC6C4840 is POINT(2.35 48.85) SRID 4326
// as Postgres prints a geography column in text format (hex EWKB).
const parisHex = "0101000020E6100000CDCCCCCCCCCC0240CDCCCCCCCC6C4840"

func TestGeoJSONFromDB(t *testing.T) {
	for _, src := range []any{parisHex, []byte(parisHex)} {
		got, err := geo.GeoJSONFromDB(src)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != `{"type":"Point","coordinates":[2.35,48.85]}` {
			t.Errorf("got %s", got)
		}
	}
	if _, err := geo.GeoJSONFromDB(42); err == nil {
		t.Error("an int must not decode")
	}
}

func TestPointScanValueJSON(t *testing.T) {
	var p geo.Point
	if err := p.Scan(parisHex); err != nil || p.Lon != 2.35 || p.Lat != 48.85 {
		t.Fatalf("scan = %+v, %v", p, err)
	}
	v, err := p.Value()
	if err != nil || v != "SRID=4326;POINT(2.35 48.85)" {
		t.Fatalf("value = %v, %v", v, err)
	}
	b, _ := json.Marshal(p)
	if string(b) != `{"type":"Point","coordinates":[2.35,48.85]}` {
		t.Errorf("json = %s", b)
	}
	var back geo.Point
	if err := json.Unmarshal(b, &back); err != nil || back != p {
		t.Errorf("unmarshal = %+v, %v", back, err)
	}
}

func TestKindOfGoType(t *testing.T) {
	for goType, want := range map[string]geo.Kind{
		"*geo.Point": geo.KindPoint, "geo.Point": geo.KindPoint,
		"*geo.Shape": geo.KindShape, "string": geo.KindNone, "": geo.KindNone,
	} {
		if got := geo.KindOfGoType(goType); got != want {
			t.Errorf("%q = %v, want %v", goType, got, want)
		}
	}
}

func TestParseLonLatAndPointSQL(t *testing.T) {
	lon, lat, err := geo.ParseLonLat(" 2.35 , 48.85 ")
	if err != nil || lon != 2.35 || lat != 48.85 {
		t.Fatalf("parse = %v %v %v", lon, lat, err)
	}
	for _, bad := range []string{"", "2.35", "a,b", "200,0", "0,-91", "1,2,3"} {
		if _, _, err := geo.ParseLonLat(bad); !errors.Is(err, geo.ErrInvalid) {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
	if got := geo.PointSQL(2.35, -48.5); got != "ST_SetSRID(ST_MakePoint(2.35, -48.5), 4326)::geography" {
		t.Errorf("PointSQL = %q", got)
	}
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd core && go test ./orm/geo/`
Expected: FAIL — package `core/orm/geo` has no Go files.

- [ ] **Step 4: Implement `core/orm/geo/geo.go`**

```go
// Package geo holds the ORM's geographic column types (ADR-029): Point and
// Shape map to PostGIS geography(…, 4326) columns. Values cross the database
// as text — Postgres prints a geography column as hex EWKB and parses EWKT on
// input — so no pgx codec has to be registered on the pool, and they cross
// the API as GeoJSON geometry objects ([lon, lat] order).
package geo

import (
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/twpayne/go-geom"
	"github.com/twpayne/go-geom/encoding/ewkb"
	"github.com/twpayne/go-geom/encoding/geojson"
	"github.com/twpayne/go-geom/encoding/wkt"
)

const (
	// SRID is WGS 84, the GPS coordinate system: every geo column uses it.
	SRID = 4326
	// MaxPositions bounds a geometry's size (a write, a stored zone).
	MaxPositions = 10000
	// maxRadius is the largest within[] radius, in meters (half the equator).
	maxRadius = 20_000_000
)

// ErrInvalid wraps every rejection of a coordinate, geometry or parameter.
var ErrInvalid = errors.New("geo: invalid geometry")

// Kind is the column flavour: a single Point, or a Shape (zone or line).
type Kind int

const (
	KindNone Kind = iota
	KindPoint
	KindShape
)

func (k Kind) String() string {
	switch k {
	case KindPoint:
		return "point"
	case KindShape:
		return "shape"
	}
	return "non-geo"
}

// KindOfGoType maps a registry FieldMeta.GoType ("*geo.Point") to its Kind.
func KindOfGoType(goType string) Kind {
	switch strings.TrimPrefix(goType, "*") {
	case "geo.Point":
		return KindPoint
	case "geo.Shape":
		return KindShape
	}
	return KindNone
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// parseGeoJSON decodes and validates one GeoJSON geometry for kind.
func parseGeoJSON(kind Kind, raw []byte) (geom.T, error) {
	var g geom.T
	if err := geojson.Unmarshal(raw, &g); err != nil || g == nil {
		return nil, invalid("not a GeoJSON geometry")
	}
	if err := validate(kind, g); err != nil {
		return nil, err
	}
	return g, nil
}

func validate(kind Kind, g geom.T) error {
	switch g.(type) {
	case *geom.Point:
		if kind != KindPoint {
			return invalid("a %s column takes Polygon, MultiPolygon or LineString", kind)
		}
	case *geom.Polygon, *geom.MultiPolygon, *geom.LineString:
		if kind != KindShape {
			return invalid("a %s column takes a Point", kind)
		}
	default:
		return invalid("unsupported geometry type")
	}
	if g.Layout() != geom.XY {
		return invalid("coordinates must be [longitude, latitude]")
	}
	flat := g.FlatCoords()
	if len(flat) == 0 {
		return invalid("empty geometry")
	}
	if len(flat)/2 > MaxPositions {
		return invalid("more than %d positions", MaxPositions)
	}
	for i := 0; i < len(flat); i += 2 {
		if err := checkLonLat(flat[i], flat[i+1]); err != nil {
			return err
		}
	}
	switch t := g.(type) {
	case *geom.Polygon:
		return checkRings(t)
	case *geom.MultiPolygon:
		for i := 0; i < t.NumPolygons(); i++ {
			if err := checkRings(t.Polygon(i)); err != nil {
				return err
			}
		}
	case *geom.LineString:
		if t.NumCoords() < 2 {
			return invalid("a line needs at least 2 positions")
		}
	}
	return nil
}

func checkRings(p *geom.Polygon) error {
	for i := 0; i < p.NumLinearRings(); i++ {
		r := p.LinearRing(i)
		n := r.NumCoords()
		if n < 4 || !r.Coord(0).Equal(geom.XY, r.Coord(n-1)) {
			return invalid("polygon rings must be closed and have at least 4 positions")
		}
	}
	return nil
}

func checkLonLat(lon, lat float64) error {
	if math.IsNaN(lon) || math.IsNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90 {
		return invalid("longitude must be within [-180, 180] and latitude within [-90, 90]")
	}
	return nil
}

// EWKTFromGeoJSON validates raw for kind and returns the EWKT Postgres
// accepts for a geography column ("SRID=4326;POINT (2.35 48.85)").
func EWKTFromGeoJSON(kind Kind, raw []byte) (string, error) {
	g, err := parseGeoJSON(kind, raw)
	if err != nil {
		return "", err
	}
	text, err := wkt.Marshal(g)
	if err != nil {
		return "", invalid("cannot encode geometry")
	}
	return fmt.Sprintf("SRID=%d;%s", SRID, text), nil
}

// decodeDB reads what pgx returns for a geography column: hex EWKB text (the
// text format pgx picks for an OID it has no codec for), as string or []byte,
// or raw binary EWKB.
func decodeDB(src any) (geom.T, error) {
	var b []byte
	switch v := src.(type) {
	case string:
		b = []byte(v)
	case []byte:
		b = v
	default:
		return nil, fmt.Errorf("geo: cannot decode %T", src)
	}
	if raw, err := hex.DecodeString(string(b)); err == nil {
		b = raw
	}
	return ewkb.Unmarshal(b)
}

// GeoJSONFromDB converts a geography column's value to a GeoJSON geometry.
func GeoJSONFromDB(src any) (json.RawMessage, error) {
	g, err := decodeDB(src)
	if err != nil {
		return nil, err
	}
	return geojson.Marshal(g)
}

// ParseLonLat parses "lon,lat" (a list/query parameter).
func ParseLonLat(s string) (lon, lat float64, err error) {
	parts := strings.Split(s, ",")
	if len(parts) != 2 {
		return 0, 0, invalid("expected <longitude>,<latitude>")
	}
	lon, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	lat, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err1 != nil || err2 != nil {
		return 0, 0, invalid("expected <longitude>,<latitude>")
	}
	if err := checkLonLat(lon, lat); err != nil {
		return 0, 0, err
	}
	return lon, lat, nil
}

// ParseRadius parses a within[] radius in meters.
func ParseRadius(s string) (float64, error) {
	m, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(m) || m <= 0 || m > maxRadius {
		return 0, invalid("radius must be a number of meters in (0, %d]", maxRadius)
	}
	return m, nil
}

func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// PointSQL is a geography point literal for SELECT/ORDER BY, where bind
// parameters don't fit the builders. The numbers come from parsed float64s,
// re-formatted — never caller text.
func PointSQL(lon, lat float64) string {
	return fmt.Sprintf("ST_SetSRID(ST_MakePoint(%s, %s), %d)::geography", num(lon), num(lat), SRID)
}

// ── Point ────────────────────────────────────────────────────────────────────

// Point is a position on the globe. Declare it as a pointer (nullable):
//
//	Location *orm.GeoPoint `db:"geo_location,index=gist"`
type Point struct{ Lon, Lat float64 }

func (p Point) Value() (driver.Value, error) {
	if err := checkLonLat(p.Lon, p.Lat); err != nil {
		return nil, err
	}
	return fmt.Sprintf("SRID=%d;POINT(%s %s)", SRID, num(p.Lon), num(p.Lat)), nil
}

func (p *Point) Scan(src any) error {
	g, err := decodeDB(src)
	if err != nil {
		return err
	}
	pt, ok := g.(*geom.Point)
	if !ok {
		return fmt.Errorf("geo: column holds a %T, not a point", g)
	}
	p.Lon, p.Lat = pt.X(), pt.Y()
	return nil
}

func (p Point) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf(`{"type":"Point","coordinates":[%s,%s]}`, num(p.Lon), num(p.Lat))), nil
}

func (p *Point) UnmarshalJSON(b []byte) error {
	g, err := parseGeoJSON(KindPoint, b)
	if err != nil {
		return err
	}
	pt := g.(*geom.Point)
	p.Lon, p.Lat = pt.X(), pt.Y()
	return nil
}

// ── Shape ────────────────────────────────────────────────────────────────────

// Shape is a zone or a line (GeoJSON Polygon, MultiPolygon or LineString).
type Shape struct{ GeoJSON json.RawMessage }

func (s Shape) Value() (driver.Value, error) { return EWKTFromGeoJSON(KindShape, s.GeoJSON) }

func (s *Shape) Scan(src any) error {
	raw, err := GeoJSONFromDB(src)
	if err != nil {
		return err
	}
	s.GeoJSON = raw
	return nil
}

func (s Shape) MarshalJSON() ([]byte, error) {
	if len(s.GeoJSON) == 0 {
		return []byte("null"), nil
	}
	return s.GeoJSON, nil
}

func (s *Shape) UnmarshalJSON(b []byte) error {
	if _, err := parseGeoJSON(KindShape, b); err != nil {
		return err
	}
	s.GeoJSON = append(json.RawMessage(nil), b...)
	return nil
}
```

- [ ] **Step 5: Run the geo tests**

Run: `cd core && go test ./orm/geo/`
Expected: PASS. If the WKT spacing differs (`POINT (2.35 48.85)` vs `POINT(2.35 48.85)`), adjust the **test expectations** to what `wkt.Marshal` emits — Postgres accepts both.

- [ ] **Step 6: Map the SQL types and re-export — failing test first**

Append to `core/orm/migrate_test.go`:

```go
type geoFixture struct {
	model.BaseModel
	Where *orm.GeoPoint `db:"where_at,index=gist"`
	Zone  *orm.GeoShape `db:"zone"`
}

func TestMigrationFieldsForTable_GeoColumns(t *testing.T) {
	if err := orm.Register[geoFixture](); err != nil {
		t.Fatal(err)
	}
	fields, _ := orm.MigrationFieldsForTable("geo_fixture")
	want := map[string]string{"where_at": "geography(Point,4326)", "zone": "geography(Geometry,4326)"}
	for _, f := range fields {
		if sqlType, ok := want[f.Column]; ok {
			delete(want, f.Column)
			if f.SQLType != sqlType || !f.Nullable {
				t.Errorf("%s = %q nullable=%v, want %q nullable", f.Column, f.SQLType, f.Nullable, sqlType)
			}
			if f.Column == "where_at" && (!f.Index || f.IndexType != "gist") {
				t.Errorf("where_at index = %v %q, want gist", f.Index, f.IndexType)
			}
		}
	}
	if len(want) > 0 {
		t.Errorf("missing: %v", want)
	}
}
```

Run: `cd core && go test -run TestMigrationFieldsForTable_GeoColumns ./orm/`
Expected: FAIL — `undefined: orm.GeoPoint`.

- [ ] **Step 7: Implement the mapping and re-exports**

`core/orm/orm.go`, next to the other type re-exports:

```go
// GeoPoint and GeoShape are the geographic column types (ADR-029): a
// geography(Point,4326) and a geography(Geometry,4326) column, GeoJSON on the
// wire. Declare them as pointers: `Location *orm.GeoPoint \`db:"geo_location,index=gist"\``.
type (
	GeoPoint = geo.Point
	GeoShape = geo.Shape
)
```

(add import `"core/orm/geo"`).

`core/orm/migrate.go` `reflectTypeToSQL`, in the first `switch t` (after deref):

```go
	case reflect.TypeOf(geo.Point{}):
		return fmt.Sprintf("geography(Point,%d)", geo.SRID)
	case reflect.TypeOf(geo.Shape{}):
		return fmt.Sprintf("geography(Geometry,%d)", geo.SRID)
```

(imports `fmt`, `core/orm/geo` as needed).

- [ ] **Step 8: Run the ORM tests**

Run: `cd core && go test ./orm/...`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
rtk git add core/go.mod core/go.sum core/orm/geo core/orm/orm.go core/orm/migrate.go core/orm/migrate_test.go
rtk git commit -m "feat(orm): GeoPoint/GeoShape geography types with GeoJSON I/O"
```

---

### Task 3: Generic CRUD reads and writes geo columns

**Files:**
- Modify: `core/orm/internal/crud/dto.go` (`ValidateRequest`, `BuildResponse`, new `GeoValidationError`, `DistanceKey`)
- Modify: `core/orm/internal/handler/generic_handler.go:229-280` (422 for `*crud.GeoValidationError` in Create and Update)
- Create: `core/orm/internal/handler/geo_integration_test.go`

**Interfaces:**
- Consumes: `geo.KindOfGoType`, `geo.EWKTFromGeoJSON`, `geo.GeoJSONFromDB` (Task 2).
- Produces: `type GeoValidationError struct{ Field string; Err error }` (crud); `const DistanceKey = "_distance_m"` (crud); `access.WithReadCheck`/`access.CanRead` (stub created here, stamped for real in Task 5); the test harness `setupGeo(t) (*orm.App, *echo.Echo)` and `doAs(e, tenant, readable, method, path, body)` reused by Tasks 4–5.

- [ ] **Step 1: Write the failing integration test**

```go
// core/orm/internal/handler/geo_integration_test.go
package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/testdb"
	"core/orm"
	"core/orm/access"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	"core/orm/model"
	ormserver "core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Test-only tables (dropped by the tests' cleanup): places carry a point,
// zones a shape.
type GeoPlace struct {
	model.BaseModel
	Name  string        `db:"name"`
	Where *orm.GeoPoint `db:"geo_location,index=gist"`
}

type GeoZone struct {
	model.BaseModel
	Name string        `db:"name"`
	Area *orm.GeoShape `db:"area,index=gist"`
}

func setupGeo(t *testing.T) (*orm.App, *echo.Echo) {
	t.Helper()
	app := testdb.Open(t)
	_ = registry.Register[GeoPlace](registry.WithTableName("geo_places"))
	_ = registry.Register[GeoZone](registry.WithTableName("geo_zones"))
	testdb.Migrate(t, app, "geo_places", "geo_zones")
	t.Cleanup(func() {
		_, _ = app.DB.Exec(context.Background(), `DROP TABLE IF EXISTS geo_places, geo_zones`)
	})
	handlers := map[string]*handler.GenericHandler{}
	for _, table := range []string{"geo_places", "geo_zones"} {
		meta, _ := registry.Get(table)
		handlers[table] = handler.NewGenericHandlerFromSvc(crud.NewService(crud.NewRepository(app.DB, meta), meta), meta)
	}
	srv := ormserver.New(app, ormserver.Config{})
	srv.RegisterRoutes(handlers, nil)
	return app, srv.Echo()
}

// doAs sends a request as tenant; readable lists the tables the caller may
// read (the permission middleware's read check), nil = none.
func doAs(e *echo.Echo, tenant uuid.UUID, readable []string, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	ctx := access.WithTenant(req.Context(), tenant)
	if readable != nil {
		ctx = access.WithReadCheck(ctx, func(table string) bool {
			for _, r := range readable {
				if r == table {
					return true
				}
			}
			return false
		})
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func decodeObj(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode %d %s: %v", rec.Code, rec.Body.String(), err)
	}
	return m
}

func TestGeo_CRUDRoundTrip(t *testing.T) {
	_, e := setupGeo(t)
	tenant := uuid.New()

	rec := doAs(e, tenant, nil, http.MethodPost, "/api/v1/geo_places",
		`{"name":"Paris","geo_location":{"type":"Point","coordinates":[2.35,48.85]}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	created := decodeObj(t, rec)
	id := created["id"].(string)
	loc, _ := json.Marshal(created["geo_location"])
	if string(loc) != `{"coordinates":[2.35,48.85],"type":"Point"}` {
		t.Errorf("created geo_location = %s", loc)
	}

	got := decodeObj(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places/"+id, ""))
	if loc, _ := json.Marshal(got["geo_location"]); string(loc) != `{"coordinates":[2.35,48.85],"type":"Point"}` {
		t.Errorf("read geo_location = %s", loc)
	}

	// Clearing stores NULL (Review Focus 3).
	rec = doAs(e, tenant, nil, http.MethodPut, "/api/v1/geo_places/"+id, `{"name":"Paris","geo_location":null}`)
	if rec.Code != http.StatusOK || decodeObj(t, rec)["geo_location"] != nil {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	}

	// A zone round-trips as its GeoJSON polygon.
	rec = doAs(e, tenant, nil, http.MethodPost, "/api/v1/geo_zones",
		`{"name":"Z","area":{"type":"Polygon","coordinates":[[[2,48],[3,48],[3,49],[2,49],[2,48]]]}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("zone: %d %s", rec.Code, rec.Body.String())
	}
	if area := decodeObj(t, rec)["area"].(map[string]any); area["type"] != "Polygon" {
		t.Errorf("area = %v", area)
	}
}

func TestGeo_InvalidGeometryIs422(t *testing.T) {
	_, e := setupGeo(t)
	for _, body := range []string{
		`{"name":"x","geo_location":{"type":"Point","coordinates":[200,0]}}`,
		`{"name":"x","geo_location":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}}`,
		`{"name":"x","geo_location":"POINT(1 2)"}`,
	} {
		rec := doAs(e, uuid.New(), nil, http.MethodPost, "/api/v1/geo_places", body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
			continue
		}
		errObj := decodeObj(t, rec)["error"].(map[string]any)
		if errObj["code"] != "VALIDATION_ERROR" {
			t.Errorf("%s: %v", body, errObj)
		}
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -run TestGeo_ ./orm/internal/handler/`
Expected: FAIL to compile — `undefined: access.WithReadCheck`. Add the stub now so the file compiles (Task 5 gives it its real use):

```go
// core/orm/access/read.go
package access

import "context"

// Per-request "may the caller read table X" check, stamped by the permission
// middleware (it evaluates <table>:<table>:read for the caller's roles) so the
// generic CRUD layer can authorize a reference to ANOTHER table — a geo
// `inside` filter, a distance — without importing core/internal/auth.

type readCheckKey struct{}

// WithReadCheck returns ctx carrying the caller's read check.
func WithReadCheck(ctx context.Context, canRead func(table string) bool) context.Context {
	return context.WithValue(ctx, readCheckKey{}, canRead)
}

// CanRead reports whether the caller may read table. False when no check was
// stamped (anonymous/public request, wiring gap): fail closed.
func CanRead(ctx context.Context, table string) bool {
	fn, ok := ctx.Value(readCheckKey{}).(func(string) bool)
	return ok && fn(table)
}
```

Run again. Expected: FAIL — the create returns 500 or a raw `geo_location` string (the column value is not converted).

- [ ] **Step 3: Implement the conversions in `dto.go`**

Add (imports `encoding/json`, `errors`, `core/orm/geo`):

```go
// DistanceKey is the computed, read-only key a `near` list adds to each row.
const DistanceKey = "_distance_m"

// GeoValidationError reports an invalid geometry in a write body; the handler
// answers 422 VALIDATION_ERROR naming the field, like a missing field.
type GeoValidationError struct {
	Field string
	Err   error
}

func (e *GeoValidationError) Error() string { return e.Field + ": " + e.Err.Error() }
func (e *GeoValidationError) Unwrap() error { return e.Err }

// geoWriteValue turns a body's GeoJSON value into the EWKT text a geography
// column accepts; nil (clearing the field) passes through.
func geoWriteValue(kind geo.Kind, val any) (any, error) {
	if val == nil {
		return nil, nil
	}
	raw, err := json.Marshal(val)
	if err != nil {
		return nil, fmt.Errorf("%w: not JSON", geo.ErrInvalid)
	}
	return geo.EWKTFromGeoJSON(kind, raw)
}
```

In `ValidateRequest`, replace `result[f.Column] = val` with:

```go
		if ok {
			if kind := geo.KindOfGoType(f.GoType); kind != geo.KindNone {
				converted, err := geoWriteValue(kind, val)
				if err != nil {
					return nil, &GeoValidationError{Field: f.Name, Err: err}
				}
				val = converted
			}
			result[f.Column] = val
		} else if ...
```

In `BuildResponse`, inside the loop, replace `out[f.Name] = val` with:

```go
		if val, ok := row[f.Column]; ok {
			if geo.KindOfGoType(f.GoType) != geo.KindNone && val != nil {
				gj, err := geo.GeoJSONFromDB(val)
				if err != nil {
					val = nil // undecodable: never leak raw EWKB
				} else {
					val = gj
				}
			}
			out[f.Name] = val
		}
```

and after the loop, before `return out`:

```go
	if d, ok := row[DistanceKey]; ok {
		out[DistanceKey] = d
	}
```

- [ ] **Step 4: Map the error to 422 in the handler**

In `generic_handler.go`, in both `Create` and `Update`, extend the `ValidateRequest` error branch:

```go
	if err != nil {
		var ve *crud.ValidationError
		if errors.As(err, &ve) {
			return validationJSON(c, err.Error(), ve.Missing)
		}
		var ge *crud.GeoValidationError
		if errors.As(err, &ge) {
			return validationJSON(c, err.Error(), []string{ge.Field})
		}
		return err
	}
```

and add the shared helper (replacing the two inline `c.JSON(http.StatusUnprocessableEntity, …)` blocks):

```go
// validationJSON is the 422 VALIDATION_ERROR envelope, `fields` naming the
// offending fields.
func validationJSON(c *echo.Context, message string, fields []string) error {
	return c.JSON(http.StatusUnprocessableEntity, map[string]any{
		"error": map[string]any{
			"code":       "VALIDATION_ERROR",
			"message":    message,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
			"fields":     fields,
		},
	})
}
```

- [ ] **Step 5: Run the tests**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 ./orm/...`
Expected: PASS. **If the create fails with a pgx encode error** (pgx refusing a `string` for the unknown geography OID), wrap EWKT values as `pgtype.Text{String: s, Valid: true}` in `geoWriteValue` and in `Point.Value`/`Shape.Value` keep the string — re-run. **If the read returns `[]byte` binary** instead of hex text, `GeoJSONFromDB` already handles it (raw EWKB fallback).

- [ ] **Step 6: Commit**

```bash
rtk git add core/orm/access/read.go core/orm/internal/crud/dto.go core/orm/internal/handler/generic_handler.go core/orm/internal/handler/geo_integration_test.go
rtk git commit -m "feat(orm): generic CRUD reads/writes geo columns as GeoJSON"
```

---

### Task 4: List params `near`, `within`, `covers`

**Files:**
- Create: `core/orm/internal/crud/geo.go`
- Modify: `core/orm/internal/crud/service.go:17-42` (`ListFilter.Geo`)
- Modify: `core/orm/internal/crud/repository.go` (`filterConditions` appends geo conditions; `FindAll` applies `near`)
- Modify: `core/orm/internal/handler/generic_handler.go` (`listFilter` parses the 4 prefixes; `List` maps `ErrGeoParam`→400, `ErrGeoRef`→404)
- Test: `core/orm/internal/handler/geo_integration_test.go` (append)

**Interfaces:**
- Produces (crud):
  - `type GeoFilter struct{ Near, Within, Covers, Inside map[string]string }`; `ListFilter.Geo GeoFilter`.
  - `var ErrGeoParam` (→400), `var ErrGeoRef` (→404).
  - `func (r *Repository) geoConditions(ctx context.Context, f GeoFilter) ([]query.Condition, error)` — within/covers/inside.
  - `func (r *Repository) nearClause(ctx context.Context, f GeoFilter) (selectExpr, orderExpr string, err error)` — `""` when no near.

- [ ] **Step 1: Write the failing test**

Append to `geo_integration_test.go`:

```go
func createGeo(t *testing.T, e *echo.Echo, tenant uuid.UUID, path, body string) string {
	t.Helper()
	rec := doAs(e, tenant, nil, http.MethodPost, path, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %s: %d %s", path, rec.Code, rec.Body.String())
	}
	return decodeObj(t, rec)["id"].(string)
}

func names(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var body struct{ Data []map[string]any }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	out := []string{}
	for _, row := range body.Data {
		out = append(out, row["name"].(string))
	}
	return out
}

func TestGeo_NearWithinCovers(t *testing.T) {
	_, e := setupGeo(t)
	tenant := uuid.New()
	pt := func(lon, lat string) string { return `{"type":"Point","coordinates":[` + lon + `,` + lat + `]}` }
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Paris","geo_location":`+pt("2.35", "48.85")+`}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Lyon","geo_location":`+pt("4.83", "45.76")+`}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Versailles","geo_location":`+pt("2.13", "48.80")+`}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Nowhere"}`) // no location (Review Focus 2)
	createGeo(t, e, tenant, "/api/v1/geo_zones", `{"name":"IDF","area":{"type":"Polygon","coordinates":[[[1.4,48.1],[3.6,48.1],[3.6,49.3],[1.4,49.3],[1.4,48.1]]]}}`)

	// Nearest to Paris first; the unlocated row last with a null distance.
	rec := doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places?near[geo_location]=2.35,48.85", "")
	if got := names(t, rec); len(got) != 4 || got[0] != "Paris" || got[1] != "Versailles" || got[2] != "Lyon" || got[3] != "Nowhere" {
		t.Errorf("near order = %v", got)
	}
	var body struct{ Data []map[string]any }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if d, _ := body.Data[1]["_distance_m"].(float64); d < 15000 || d > 17000 {
		t.Errorf("Paris→Versailles = %v m, want ~16 km", body.Data[1]["_distance_m"])
	}
	if body.Data[3]["_distance_m"] != nil {
		t.Errorf("unlocated distance = %v, want null", body.Data[3]["_distance_m"])
	}
	if _, ok := decodeObj(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places", ""))["data"].([]any)[0].(map[string]any)["_distance_m"]; ok {
		t.Error("_distance_m present without near")
	}

	// 50 km radius around Paris.
	if got := names(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places?within[geo_location]=2.35,48.85,50000&near[geo_location]=2.35,48.85", "")); len(got) != 2 {
		t.Errorf("within = %v, want Paris+Versailles", got)
	}
	// Which zone covers Paris / Lyon.
	if got := names(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_zones?covers[area]=2.35,48.85", "")); len(got) != 1 {
		t.Errorf("covers Paris = %v", got)
	}
	if got := names(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_zones?covers[area]=4.83,45.76", "")); len(got) != 0 {
		t.Errorf("covers Lyon = %v", got)
	}

	for _, bad := range []string{
		"/api/v1/geo_places?near[geo_location]=200,0",
		"/api/v1/geo_places?near[name]=2,48",
		"/api/v1/geo_places?within[geo_location]=2,48",
		"/api/v1/geo_places?within[geo_location]=2,48,-5",
		"/api/v1/geo_zones?covers[geo_location]=2,48",
		"/api/v1/geo_places?covers[geo_location]=2,48",
	} {
		if rec := doAs(e, tenant, nil, http.MethodGet, bad, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", bad, rec.Code)
		}
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -run TestGeo_NearWithinCovers ./orm/internal/handler/`
Expected: FAIL — the params are ignored (unknown prefixes), order is unspecified.

- [ ] **Step 3: Implement `crud/geo.go`**

```go
package crud

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"core/orm/geo"
	"core/orm/query"
)

// ErrGeoParam is a malformed geo list parameter or a geo param on a column
// of the wrong kind (400). ErrGeoRef is a record reference the caller can't
// use — unknown, excluded or unreadable table, non-shape column, gated column
// (404, so the reason isn't revealed).
var (
	ErrGeoParam = errors.New("crud: invalid geo parameter")
	ErrGeoRef   = errors.New("crud: geo reference not found")
)

// GeoFilter carries the generic list's geo params, keyed by column:
// Near "lon,lat" (order + _distance_m), Within "lon,lat,meters",
// Covers "lon,lat" (shape column), Inside "table:id:shape_col" (point column).
type GeoFilter struct {
	Near, Within, Covers, Inside map[string]string
}

func geoParamErr(col string, err error) error {
	return fmt.Errorf("%w: %s: %v", ErrGeoParam, col, err)
}

// geoColumn checks col like any filter column (whitelist, gating, public
// scope) and that it holds the wanted geo kind.
func (r *Repository) geoColumn(ctx context.Context, col string, want geo.Kind) error {
	if err := r.checkColumn(ctx, col); err != nil {
		return err
	}
	fm, _ := r.meta.FieldByColumn(col)
	if geo.KindOfGoType(fm.GoType) != want {
		return geoParamErr(col, fmt.Errorf("not a %s column", want))
	}
	return nil
}

// geoConditions turns Within/Covers/Inside into WHERE predicates (they also
// narrow ?distinct= and ?aggregate=, like every filter).
func (r *Repository) geoConditions(ctx context.Context, f GeoFilter) ([]query.Condition, error) {
	var conds []query.Condition
	for _, col := range sortedKeys(f.Within) {
		if err := r.geoColumn(ctx, col, geo.KindPoint); err != nil {
			return nil, err
		}
		parts := strings.Split(f.Within[col], ",")
		if len(parts) != 3 {
			return nil, geoParamErr(col, errors.New("within takes <longitude>,<latitude>,<meters>"))
		}
		lon, lat, err := geo.ParseLonLat(parts[0] + "," + parts[1])
		if err != nil {
			return nil, geoParamErr(col, err)
		}
		meters, err := geo.ParseRadius(parts[2])
		if err != nil {
			return nil, geoParamErr(col, err)
		}
		conds = append(conds, query.NewCondition(
			fmt.Sprintf("ST_DWithin(%s, ST_SetSRID(ST_MakePoint($1, $2), %d)::geography, $3)", col, geo.SRID),
			lon, lat, meters))
	}
	for _, col := range sortedKeys(f.Covers) {
		if err := r.geoColumn(ctx, col, geo.KindShape); err != nil {
			return nil, err
		}
		lon, lat, err := geo.ParseLonLat(f.Covers[col])
		if err != nil {
			return nil, geoParamErr(col, err)
		}
		conds = append(conds, query.NewCondition(
			fmt.Sprintf("ST_Covers(%s, ST_SetSRID(ST_MakePoint($1, $2), %d)::geography)", col, geo.SRID),
			lon, lat))
	}
	for _, col := range sortedKeys(f.Inside) {
		cond, err := r.insideCondition(ctx, col, f.Inside[col])
		if err != nil {
			return nil, err
		}
		conds = append(conds, cond)
	}
	return conds, nil
}

// nearClause returns the _distance_m select expression and the ORDER BY for a
// Near param ("" when absent). One near per request: it is the list's order.
func (r *Repository) nearClause(ctx context.Context, f GeoFilter) (selectExpr, orderExpr string, err error) {
	if len(f.Near) == 0 {
		return "", "", nil
	}
	if len(f.Near) > 1 {
		return "", "", fmt.Errorf("%w: only one near[] per request", ErrGeoParam)
	}
	for col, val := range f.Near {
		if err := r.geoColumn(ctx, col, geo.KindPoint); err != nil {
			return "", "", err
		}
		lon, lat, err := geo.ParseLonLat(val)
		if err != nil {
			return "", "", geoParamErr(col, err)
		}
		p := geo.PointSQL(lon, lat)
		return fmt.Sprintf("ST_Distance(%s, %s) AS %s", col, p, DistanceKey),
			fmt.Sprintf("%s <-> %s", col, p), nil
	}
	return "", "", nil
}

// insideCondition is implemented in Task 5; until then inside[] is refused.
func (r *Repository) insideCondition(_ context.Context, col, _ string) (query.Condition, error) {
	return query.Condition{}, geoParamErr(col, errors.New("inside is not supported yet"))
}
```

- [ ] **Step 4: Wire it into the repository, service and handler**

`service.go` `ListFilter`, after `Empty`:

```go
	// Geo holds the geo params (near/within/covers/inside) — see GeoFilter.
	Geo GeoFilter
```

`repository.go` `filterConditions`, before the final `return conds, nil`:

```go
	geoConds, err := r.geoConditions(ctx, f.Geo)
	if err != nil {
		return nil, err
	}
	conds = append(conds, geoConds...)
```

`repository.go` `FindAll`, right after the `filters` loop:

```go
	distanceExpr, orderExpr, err := r.nearClause(ctx, f.Geo)
	if err != nil {
		return nil, 0, err
	}
	if distanceExpr != "" {
		b = b.Columns(append(r.meta.StructMeta.Columns(), distanceExpr)...).OrderBy(orderExpr)
	}
```

(`Count()` already drops columns and ORDER BY.)

`generic_handler.go` `listFilter`: add before the `singleValueMaps` loop body's `for _, sv := range` — as an extra block inside `for key, vals := range c.QueryParams()`:

```go
		if handled, err := h.geoParam(&f, key, vals[0]); err != nil {
			return f, err
		} else if handled {
			continue
		}
```

and the method:

```go
// geoParam files a near[]/within[]/covers[]/inside[] param into f.Geo
// (columns re-checked, with their geo kind, by the repository).
func (h *GenericHandler) geoParam(f *crud.ListFilter, key, val string) (bool, error) {
	for _, g := range []struct {
		prefix string
		into   *map[string]string
	}{{"near", &f.Geo.Near}, {"within", &f.Geo.Within}, {"covers", &f.Geo.Covers}, {"inside", &f.Geo.Inside}} {
		col, ok := bracketColumn(key, g.prefix)
		if !ok {
			continue
		}
		if !h.meta.HasField(col) {
			return true, echo.NewHTTPError(http.StatusBadRequest, "unknown filter column: "+col)
		}
		if *g.into == nil {
			*g.into = map[string]string{}
		}
		(*g.into)[col] = val
		return true, nil
	}
	return false, nil
}
```

In `List`, wherever `crud.ErrUnknownColumn` maps to 400, route through one helper:

```go
// listErr maps the list/distinct/aggregate errors callers can cause.
func listErr(err error) error {
	switch {
	case errors.Is(err, crud.ErrUnknownColumn), errors.Is(err, crud.ErrBadAggregate), errors.Is(err, crud.ErrGeoParam):
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	case errors.Is(err, crud.ErrGeoRef):
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	return err
}
```

(replace each `if errors.Is(err, crud.ErrUnknownColumn) … return echo.NewHTTPError(400…) } return err` in `List` with `return listErr(err)`).

- [ ] **Step 5: Run the tests**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 ./orm/...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add core/orm/internal/crud core/orm/internal/handler
rtk git commit -m "feat(orm): near/within/covers geo list params"
```

---

### Task 5: `inside` references, read check, distance between records

**Files:**
- Modify: `core/orm/internal/crud/geo.go` (`resolveGeoRef`, real `insideCondition`, `Distance`)
- Modify: `core/orm/orm.go` (facade `GeoDistance`, errors)
- Modify: `core/internal/middleware/permission.go` (stamp `access.WithReadCheck`)
- Create: `core/internal/geo/handler.go`, `core/internal/geo/handler_test.go`
- Modify: `core/internal/app/app.go` (mount `/api/v1/geo`)
- Test: `core/orm/internal/handler/geo_integration_test.go` (append), `core/internal/middleware/permission_test.go` (append)

**Interfaces:**
- Consumes: `access.WithReadCheck`/`CanRead` (Task 3), `GeoFilter` (Task 4).
- Produces:
  - `func resolveGeoRef(ctx context.Context, ref string, want geo.Kind, argOffset int) (sql string, args []any, err error)` — `want == geo.KindNone` accepts either kind.
  - `func Distance(ctx context.Context, db executor.Executor, from, to string) (*float64, error)` (crud); facade `orm.GeoDistance` = same; `orm.ErrGeoParam`, `orm.ErrGeoRef`.
  - Route `GET /api/v1/geo/distance?from=&to=` → `{"meters": number|null}`, permission `geo:distance:read`.

- [ ] **Step 1: Write the failing tests**

Append to `geo_integration_test.go`:

```go
func TestGeo_Inside(t *testing.T) {
	_, e := setupGeo(t)
	tenant := uuid.New()
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Paris","geo_location":{"type":"Point","coordinates":[2.35,48.85]}}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Lyon","geo_location":{"type":"Point","coordinates":[4.83,45.76]}}`)
	zone := createGeo(t, e, tenant, "/api/v1/geo_zones", `{"name":"IDF","area":{"type":"Polygon","coordinates":[[[1.4,48.1],[3.6,48.1],[3.6,49.3],[1.4,49.3],[1.4,48.1]]]}}`)
	path := "/api/v1/geo_places?inside[geo_location]=geo_zones:" + zone + ":area"
	readable := []string{"geo_places", "geo_zones"}

	if got := names(t, doAs(e, tenant, readable, http.MethodGet, path, "")); len(got) != 1 || got[0] != "Paris" {
		t.Errorf("inside = %v, want [Paris]", got)
	}
	// Another tenant's zone matches nothing, without revealing it exists.
	if got := names(t, doAs(e, uuid.New(), readable, http.MethodGet, path, "")); len(got) != 0 {
		t.Errorf("other tenant = %v", got)
	}
	// Unreadable zone table, non-shape column, unknown table → 404.
	for _, tc := range []struct {
		path     string
		readable []string
	}{
		{path, []string{"geo_places"}},
		{path, nil},
		{"/api/v1/geo_places?inside[geo_location]=geo_zones:" + zone + ":name", readable},
		{"/api/v1/geo_places?inside[geo_location]=nope:" + zone + ":area", readable},
	} {
		if rec := doAs(e, tenant, tc.readable, http.MethodGet, tc.path, ""); rec.Code != http.StatusNotFound {
			t.Errorf("%s (readable %v) = %d, want 404", tc.path, tc.readable, rec.Code)
		}
	}
	if rec := doAs(e, tenant, readable, http.MethodGet, "/api/v1/geo_places?inside[geo_location]=garbage", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("malformed ref = %d, want 400", rec.Code)
	}
}

func TestGeo_Distance(t *testing.T) {
	app, e := setupGeo(t)
	tenant := uuid.New()
	paris := createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Paris","geo_location":{"type":"Point","coordinates":[2.35,48.85]}}`)
	lyon := createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Lyon","geo_location":{"type":"Point","coordinates":[4.83,45.76]}}`)
	none := createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Nowhere"}`)
	zone := createGeo(t, e, tenant, "/api/v1/geo_zones", `{"name":"IDF","area":{"type":"Polygon","coordinates":[[[1.4,48.1],[3.6,48.1],[3.6,49.3],[1.4,49.3],[1.4,48.1]]]}}`)

	ctx := access.WithReadCheck(access.WithTenant(context.Background(), tenant), func(string) bool { return true })
	d, err := crud.Distance(ctx, app.DB, "geo_places:"+paris+":geo_location", "geo_places:"+lyon+":geo_location")
	if err != nil || d == nil || *d < 390000 || *d > 395000 {
		t.Fatalf("Paris→Lyon = %v, %v; want ~392 km", d, err)
	}
	if d, _ := crud.Distance(ctx, app.DB, "geo_places:"+paris+":geo_location", "geo_zones:"+zone+":area"); d == nil || *d != 0 {
		t.Errorf("Paris→IDF = %v, want 0 (inside)", d)
	}
	if d, err := crud.Distance(ctx, app.DB, "geo_places:"+none+":geo_location", "geo_places:"+lyon+":geo_location"); err != nil || d != nil {
		t.Errorf("unlocated = %v, %v; want nil", d, err)
	}
	noRead := access.WithTenant(context.Background(), tenant)
	if _, err := crud.Distance(noRead, app.DB, "geo_places:"+paris+":geo_location", "geo_places:"+lyon+":geo_location"); !errors.Is(err, crud.ErrGeoRef) {
		t.Errorf("unreadable = %v, want ErrGeoRef", err)
	}
}
```

(add `"errors"` to the imports.)

Append to `core/internal/middleware/permission_test.go` a test that a request passing the middleware carries a read check answering through the checker (adapt to the file's existing stub `permissionChecker` and request helper):

```go
func TestPermissionMiddleware_StampsReadCheck(t *testing.T) {
	perms := stubPerms{granted: map[string]bool{"crm:crm:read": true, "contact:contact:read": true}}
	var canContact, canSecret bool
	h := PermissionMiddleware(perms)(func(c *echo.Context) error {
		canContact = access.CanRead(c.Request().Context(), "contact")
		canSecret = access.CanRead(c.Request().Context(), "secret")
		return nil
	})
	c := newAuthedContext(t, http.MethodGet, "/api/v1/crm") // the file's existing helper building an identity-carrying context
	if err := h(c); err != nil {
		t.Fatal(err)
	}
	if !canContact || canSecret {
		t.Errorf("contact=%v secret=%v, want true/false", canContact, canSecret)
	}
}
```

If the test file has no `stubPerms`/`newAuthedContext`, add them next to the test: `stubPerms` implements `Has(ctx, roles, required) (bool, error)` as `s.granted[required]`; `newAuthedContext` builds `echo.New().NewContext(httptest.NewRequest(method, path, nil), httptest.NewRecorder())`, sets `c.SetPath(path)`, and stamps `auth.WithIdentity(ctx, auth.Identity{Roles: []string{"r"}})` (use whatever identity setter `auth.MustIdentity` reads — check `internal/auth/identity.go`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -run 'TestGeo_Inside|TestGeo_Distance' ./orm/internal/handler/ && go test -run TestPermissionMiddleware_StampsReadCheck ./internal/middleware/`
Expected: FAIL — `undefined: crud.Distance`; inside answers 400; no read check stamped.

- [ ] **Step 3: Implement reference resolution, `inside` and `Distance` in `crud/geo.go`**

Replace the Task 4 `insideCondition` stub with:

```go
// resolveGeoRef turns "table:id:column" into a scalar subquery selecting that
// record's geography value, after the same checks a list read of that table
// would make: registered and on the CRUD surface, readable by the caller
// (access.CanRead), column of the wanted kind (KindNone = any geo) and not
// gated for the caller. Tenant and soft-delete scoping live IN the subquery,
// so a missing or foreign record yields NULL — nothing matches, nothing leaks.
// argOffset is the $n of the subquery's first argument.
func resolveGeoRef(ctx context.Context, ref string, want geo.Kind, argOffset int) (string, []any, error) {
	parts := strings.Split(ref, ":")
	if len(parts) != 3 {
		return "", nil, fmt.Errorf("%w: reference must be <table>:<id>:<column>", ErrGeoParam)
	}
	table, rawID, col := parts[0], parts[1], parts[2]
	id, err := uuid.Parse(rawID)
	if err != nil {
		return "", nil, fmt.Errorf("%w: reference id must be a uuid", ErrGeoParam)
	}
	if _, public := access.PublicScopeFromContext(ctx); public {
		return "", nil, fmt.Errorf("%w: references are not available publicly", ErrGeoParam)
	}
	meta, ok := registry.Get(table)
	if !ok || meta.Excluded || !access.CanRead(ctx, table) {
		return "", nil, ErrGeoRef
	}
	fm, ok := meta.FieldByColumn(col)
	if !ok {
		return "", nil, ErrGeoRef
	}
	kind := geo.KindOfGoType(fm.GoType)
	if kind == geo.KindNone || (want != geo.KindNone && kind != want) {
		return "", nil, ErrGeoRef
	}
	if len(fm.Groups) > 0 {
		callerGroups, _ := access.GroupsFromContext(ctx)
		if !intersects(fm.Groups, callerGroups) {
			return "", nil, ErrGeoRef
		}
	}
	args := []any{id}
	where := fmt.Sprintf("z.%s = $%d", meta.PKField.Column, argOffset)
	if meta.HasField(tenantColumn) {
		tid, ok := access.TenantFromContext(ctx)
		if !ok || tid == uuid.Nil {
			return "", nil, ErrGeoRef
		}
		args = append(args, tid)
		where += fmt.Sprintf(" AND z.%s = $%d", tenantColumn, argOffset+1)
	}
	if meta.SoftDelete {
		where += " AND z.deleted_at IS NULL"
	}
	return fmt.Sprintf("(SELECT z.%s FROM %s z WHERE %s)", col, meta.TableName, where), args, nil
}

// insideCondition keeps rows whose point col lies in the referenced zone.
func (r *Repository) insideCondition(ctx context.Context, col, ref string) (query.Condition, error) {
	if err := r.geoColumn(ctx, col, geo.KindPoint); err != nil {
		return query.Condition{}, err
	}
	sub, args, err := resolveGeoRef(ctx, ref, geo.KindShape, 1)
	if err != nil {
		return query.Condition{}, err
	}
	return query.NewCondition(fmt.Sprintf("ST_Covers(%s, %s)", sub, col), args...), nil
}

// Distance returns the distance in meters between two referenced geo values
// (point–point, point–zone: 0 inside, else to the boundary; zone–zone), or
// nil when either is empty or its record is missing.
func Distance(ctx context.Context, db executor.Executor, from, to string) (*float64, error) {
	a, aArgs, err := resolveGeoRef(ctx, from, geo.KindNone, 1)
	if err != nil {
		return nil, err
	}
	b, bArgs, err := resolveGeoRef(ctx, to, geo.KindNone, 1+len(aArgs))
	if err != nil {
		return nil, err
	}
	var meters *float64
	if err := db.QueryRow(ctx, fmt.Sprintf("SELECT ST_Distance(%s, %s)", a, b), append(aArgs, bArgs...)...).Scan(&meters); err != nil {
		return nil, fmt.Errorf("crud: distance: %w", err)
	}
	return meters, nil
}
```

(imports: `core/orm/access`, `core/orm/internal/registry`, `core/orm/pool/executor`, `github.com/google/uuid`.)

- [ ] **Step 4: Facade, middleware stamp, HTTP handler and route**

`core/orm/orm.go`:

```go
// GeoDistance returns the distance in meters between two "table:id:column"
// references (nil when either side is empty), checking the caller may read
// both — see ADR-029.
func GeoDistance(ctx context.Context, db Executor, from, to string) (*float64, error) {
	return crud.Distance(ctx, db, from, to)
}

// ErrGeoParam (malformed geo parameter, 400) and ErrGeoRef (unusable
// reference, 404) — returned by GeoDistance and the generic list.
var (
	ErrGeoParam = crud.ErrGeoParam
	ErrGeoRef   = crud.ErrGeoRef
)
```

`core/internal/middleware/permission.go`, just before `return next(c)`:

```go
			// Stamp the per-request read check the generic CRUD layer uses to
			// authorize references to OTHER tables (geo inside[], distance):
			// <table>:<table>:read for the caller's roles, memoized per request.
			ctx := c.Request().Context()
			seen := map[string]bool{}
			canRead := func(table string) bool {
				if v, ok := seen[table]; ok {
					return v
				}
				ok, err := perms.Has(ctx, identity.Roles, table+":"+table+":read")
				seen[table] = err == nil && ok
				return seen[table]
			}
			c.SetRequest(c.Request().WithContext(access.WithReadCheck(ctx, canRead)))
```

(import `core/orm/access`).

`core/internal/geo/handler.go`:

```go
// Package geo serves the distance between two records' geographic values
// (ADR-029). The ORM resolves and authorizes both references; this is HTTP.
package geo

import (
	"errors"
	"net/http"

	"core/orm"

	"github.com/labstack/echo/v5"
)

type Handler struct{ db orm.Executor }

func NewHandler(db orm.Executor) *Handler { return &Handler{db: db} }

// Distance handles GET /api/v1/geo/distance?from=<table>:<id>:<col>&to=…
// → {"meters": n|null}. Permission geo:distance:read (route-derived), plus
// read access to both referenced tables.
func (h *Handler) Distance(c *echo.Context) error {
	meters, err := orm.GeoDistance(c.Request().Context(), h.db, c.QueryParam("from"), c.QueryParam("to"))
	switch {
	case errors.Is(err, orm.ErrGeoParam):
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	case errors.Is(err, orm.ErrGeoRef):
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	case err != nil:
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"meters": meters})
}
```

`core/internal/geo/handler_test.go` — table test with a stub executor is not needed; the behaviors are covered by `TestGeo_Distance` and Task 13's app test. Add only a param test:

```go
package geo

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v5"
)

func TestDistance_MalformedRefIs400(t *testing.T) {
	c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, "/api/v1/geo/distance?from=x&to=y", nil), httptest.NewRecorder())
	err := NewHandler(nil).Distance(c)
	if he, ok := err.(*echo.HTTPError); !ok || he.Code != http.StatusBadRequest {
		t.Fatalf("err = %v, want 400", err)
	}
}
```

`core/internal/app/app.go`, next to the other dedicated groups (e.g. after the `website_admin` group):

```go
	// Distance between two records' geo values (ADR-029): geo:distance:read,
	// route-derived, plus read access to both referenced tables (the ORM checks).
	geoGroup := srv.Echo().Group("/api/v1/geo", jwtMw, permMw)
	geoGroup.GET("/distance", geoapi.NewHandler(app.DB).Distance)
```

(import `geoapi "core/internal/geo"`).

- [ ] **Step 5: Run the tests**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 ./orm/... ./internal/middleware/ ./internal/geo/ ./internal/app/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add core/orm core/internal/middleware core/internal/geo core/internal/app/app.go
rtk git commit -m "feat(geo): inside[] zone references and record-to-record distance"
```

---

### Task 6: Unit system in `/me/preferences`

**Files:**
- Modify: `core/internal/settings/handler.go:105-130` (`preferencesResponse.UnitSystem`), `GetMyPreferences`
- Test: `core/internal/settings/handler_test.go` (append)

**Interfaces:**
- Produces: `GET /api/v1/me/preferences` gains `"unit_system": "metric"|"imperial"` (consumed by Task 8's `LocaleSync`).

- [ ] **Step 1: Write the failing test**

Find the existing `GetMyPreferences` test in `handler_test.go` (it builds a `Handler` with stub store/companies) and add a case — same setup, store returning `UnitSystemImperial` for `UnitSystemKey`:

```go
func TestGetMyPreferences_UnitSystem(t *testing.T) {
	for _, tc := range []struct{ stored, want string }{{"", UnitSystemMetric}, {UnitSystemImperial, UnitSystemImperial}} {
		h, c, rec := newPreferencesFixture(t, map[string]string{UnitSystemKey: tc.stored}) // the file's existing fixture builder
		if err := h.GetMyPreferences(c); err != nil {
			t.Fatal(err)
		}
		var body struct {
			UnitSystem string `json:"unit_system"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body.UnitSystem != tc.want {
			t.Errorf("stored %q: unit_system = %q, want %q", tc.stored, body.UnitSystem, tc.want)
		}
	}
}
```

If no fixture builder exists, copy the setup of the nearest existing `GetMyPreferences` test into `newPreferencesFixture(t, settings map[string]string)`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && go test -run TestGetMyPreferences_UnitSystem ./internal/settings/`
Expected: FAIL — `unit_system` is empty.

- [ ] **Step 3: Implement**

Add to `preferencesResponse`:

```go
	// UnitSystem: the active company's unit system (Settings → Units), so
	// distances (geo widgets, list Distance column) display in km or mi
	// without a settings:units:read grant.
	UnitSystem string `json:"unit_system"`
```

In `GetMyPreferences`, before `return c.JSON(...)`:

```go
	unitSystem, err := resolveUnitSystem(c.Request().Context(), h.store, h.companies, identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("preferences: unit system: %w", err)
	}
	resp.UnitSystem = unitSystem
```

- [ ] **Step 4: Run the settings tests**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 ./internal/settings/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/settings
rtk git commit -m "feat(settings): expose the unit system in /me/preferences"
```

---

### Task 7: Public events "nearest" and browser geolocation policy

**Files:**
- Modify: `core/modules/event/handler.go:117-175` (`PublicUpcoming`: `?near=`, `distance_m`)
- Modify: `infra/nginx/nginx.conf:92` (`geolocation=(self)`)
- Test: lives in Task 13 (`TestPublicUpcomingEvents` near case), once `event.geo_location` exists

**Interfaces:**
- Consumes: `geo.ParseLonLat`, `geo.PointSQL` via the `orm` facade — add `orm.ParseLonLat = geo.ParseLonLat` and `orm.GeoPointSQL = geo.PointSQL` re-exports in `core/orm/orm.go` (ERP code never imports `core/orm/geo`).
- Produces: `GET /api/v1/public/events/upcoming?near=<lon>,<lat>` — rows ordered by distance of `event.geo_location` when `geo_location` is published (else the param is ignored), each with `distance_m` (null when unlocated). Bad `near` → 400.

- [ ] **Step 1: Re-export the helpers**

`core/orm/orm.go`:

```go
// ParseLonLat parses "lon,lat" and GeoPointSQL renders a geography literal
// from parsed numbers — for hand-written geo SQL (e.g. event's public list).
var (
	ParseLonLat = geo.ParseLonLat
	GeoPointSQL = geo.PointSQL
)
```

- [ ] **Step 2: Implement `near` in `PublicUpcoming`**

After the `limit` parsing:

```go
		distanceSQL, orderSQL := "NULL::float8", ""
		if raw := c.QueryParam("near"); raw != "" {
			lon, lat, err := orm.ParseLonLat(raw)
			if err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, "near must be <longitude>,<latitude>")
			}
			if scope.Allows("geo_location") { // an unpublished location must not even order the list
				p := orm.GeoPointSQL(lon, lat)
				distanceSQL = "ST_Distance(e.geo_location, " + p + ")"
				orderSQL = "e.geo_location <-> " + p + " NULLS LAST, "
			}
		}
```

(move this block **after** `scope, ok, err := resolve(...)`). Change the query: select list gains `, ` + distanceSQL + ` AS distance_m` after `n.seats_left`; `ORDER BY` becomes `ORDER BY `+orderSQL+`n.starts_at NULLS LAST, e.name`. Scan an extra `var dist *float64` and set `row["distance_m"] = dist` only when `orderSQL != ""`.

- [ ] **Step 3: nginx**

`infra/nginx/nginx.conf:92`: `geolocation=()` → `geolocation=(self)`.

- [ ] **Step 4: Build**

Run: `cd core && go build ./... && go vet ./modules/event/`
Expected: no output. (Behavior is tested in Task 13 once `event.geo_location` exists.)

- [ ] **Step 5: Commit**

```bash
rtk git add core/orm/orm.go core/modules/event/handler.go infra/nginx/nginx.conf
rtk git commit -m "feat(event): public upcoming events sortable by distance"
```

---

### Task 8: Frontend foundation — types, list options, units, geocoding coordinates

**Files:**
- Modify: `core-front/packages/core-front/src/views/descriptor.ts` (FieldType, FIELD_WIDGETS, zero defaults, FilterOperator, RelationDescriptor.inside, GeoJSON types, validation)
- Modify: `core-front/packages/core-front/src/views/behaviors.ts:176-177` (`distance` unstored)
- Modify: `core-front/packages/core-front/src/views/search-bar.tsx` (`operatorsFor` exhaustive)
- Modify: `core-front/packages/core-front/src/api/list-options.ts`, `core-front/packages/core-front/src/api/ApiClient.ts:218-242`
- Create: `core-front/packages/core-front/src/views/unit-store.ts`, `core-front/packages/core-front/src/views/distance-format.ts`, `core-front/packages/core-front/src/views/distance-format.test.ts`
- Modify: `core-front/packages/core-front/src/index.ts` (exports)
- Modify: `core-front/apps/shell/src/components/LocaleSync.tsx`, `core-front/apps/shell/src/lib/preferences.ts` (seed unit store)
- Modify: `core-front/apps/shell/app/api/integrations/osm/search/route.ts` (+ its test): suggestions carry `lat`/`lon`
- Modify: `core-front/packages/core-front/src/views/address-widget.tsx` (export `useOSMSuggestions`, `OSMSuggestion` with `lat`/`lon`)

**Interfaces:**
- Produces (engine):
  - `FieldType` gains `'geo' | 'distance'`; `FIELD_WIDGETS.geo = ['point', 'shape']`, `FIELD_WIDGETS.distance = ['meters']`.
  - `type GeoJSONGeometry = { type: 'Point'; coordinates: [number, number] } | { type: 'Polygon'; coordinates: [number, number][][] } | { type: 'MultiPolygon'; coordinates: [number, number][][][] } | { type: 'LineString'; coordinates: [number, number][] }`.
  - `FilterOperator` gains `'near' | 'inside' | 'covers'`.
  - `RelationDescriptor.inside?: { field: string; zone: string }`.
  - `EntityListOptions.near/within/covers/inside?: Record<string, string>`.
  - `useUnitStore` (`{ system: 'metric' | 'imperial'; setSystem }`), `formatDistance(meters: number | null | undefined, system, locale: string | null): string`.
  - `useOSMSuggestions()` and `OSMSuggestion` (`label, number, street, complement, zip_code, city, state, country, lat: number | null, lon: number | null`) exported from the engine.

- [ ] **Step 1: Write the failing tests**

```ts
// core-front/packages/core-front/src/views/distance-format.test.ts
import { describe, expect, it } from 'vitest'
import { formatDistance } from './distance-format'

describe('formatDistance', () => {
  it.each([
    [null, 'metric', '—'],
    [undefined, 'metric', '—'],
    [0, 'metric', '0 m'],
    [742.4, 'metric', '742 m'],
    [12_400, 'metric', '12.4 km'],
    [12_400, 'imperial', '7.7 mi'],
    [50, 'imperial', '164 ft'],
  ] as const)('%s m (%s) → %s', (m, system, want) => {
    expect(formatDistance(m, system, 'en')).toBe(want)
  })
  it('uses the locale decimal separator', () => {
    expect(formatDistance(12_400, 'metric', 'fr')).toBe('12,4 km')
  })
})
```

Append to `core-front/packages/core-front/src/views/descriptor.test.ts`:

```ts
describe('geo field types', () => {
  it('resolves geo/point by default, geo/shape and distance/meters', () => {
    expect(resolveWidget({ name: 'loc', type: 'geo' })).toBe('point')
    expect(resolveWidget({ name: 'zone', type: 'geo', widget: 'shape' })).toBe('shape')
    expect(resolveWidget({ name: 'd', type: 'distance' })).toBe('meters')
    expect(() => resolveWidget({ name: 'loc', type: 'geo', widget: 'stars' })).toThrow(/not allowed/)
  })
  it('zero-defaults both to null', () => {
    expect(fieldZeroDefault({ name: 'loc', type: 'geo' })).toBeNull()
    expect(fieldZeroDefault({ name: 'd', type: 'distance' })).toBeNull()
  })
})
```

Append to the OSM route test (`apps/shell/app/api/integrations/osm/search/route.test.ts`) an assertion in its "maps Nominatim results" case that a result `{ lat: '48.85', lon: '2.35', ... }` maps to `lat: 48.85, lon: 2.35`, and a result without them to `lat: null, lon: null`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd core-front/packages/core-front && npx vitest run src/views/distance-format.test.ts src/views/descriptor.test.ts`
Expected: FAIL — missing module / unknown field type `geo`.

- [ ] **Step 3: Implement the engine pieces**

`descriptor.ts`:

```ts
export type FieldType =
  | 'text' | 'number' | 'date' | 'relation' | 'boolean' | 'selection' | 'totals' | 'address'
  | 'geo'
  | 'distance'

/** A GeoJSON geometry object as the API speaks it ([lon, lat] order). */
export type GeoJSONGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
```

`FIELD_WIDGETS` gains `geo: ['point', 'shape'], distance: ['meters'],` and the doc comment above it a paragraph:

```ts
 * type/geo is a PostGIS geography column, GeoJSON in the draft (ADR-029):
 * 'point' a draggable marker on a map (+ address search, "Locate from
 * address" via widgetOptions.address), 'shape' a polygon editor. type/distance
 * (widget 'meters', always store:false) asks Go for the distance between two
 * geo values — widgetOptions {from, to}, each {entity, id?, field}, id naming
 * the draft field holding the record id (omitted = this record).
```

`fieldZeroDefault`: add `case 'geo':` and `case 'distance':` to the `return null` group.

`FilterOperator`: `'eq' | 'contains' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'near' | 'inside' | 'covers'`; `FilterCondition.value` doc: `near: "lon,lat" or "lon,lat,meters"; inside: "table:id:column"; covers: "lon,lat"`.

`RelationDescriptor`, after `inverseField`:

```ts
  /**
   * one2many by zone, instead of `inverseField`: rows of `entity` whose
   * `field` point lies inside THIS record's `zone` shape (Go `inside[]`).
   * Read-only by nature — no FK to preset on a create.
   */
  inside?: { field: string; zone: string }
```

and in its validation (`descriptor.ts:382`): `if (rel.kind === 'one2many' && !rel.inverseField && !rel.inside)` with the message `one2many relations require inverseField or inside`.

`behaviors.ts:177`: `.filter((f) => f.store === false || isVirtualRelation(f) || f.type === 'address' || f.type === 'distance')`.

`search-bar.tsx` `operatorsFor`:

```ts
    case 'geo':
      return field.widget === 'shape' ? ['covers'] : ['near', 'inside']
    case 'totals':
    case 'address':
    case 'distance':
      return []
```

and `OPERATOR_LABEL` gains `near: 'near', inside: 'inside zone of', covers: 'covers'`. (Task 12 adds the value editors and `toListOptions` cases.)

`list-options.ts`:

```ts
  /** Geo params (ADR-029), keyed by column: near "lon,lat" (nearest first,
   * adds `_distance_m`), within "lon,lat,meters", covers "lon,lat" (shape
   * column), inside "table:id:shape_column" (point column). */
  near?: Record<string, string>
  within?: Record<string, string>
  covers?: Record<string, string>
  inside?: Record<string, string>
```

and `MAP_KEYS` = `['filter', 'search', 'in', 'gt', 'gte', 'lt', 'lte', 'near', 'within', 'covers', 'inside'] as const`.

`ApiClient.ts` `appendListParams`, extend the prefix loop:

```ts
  for (const [prefix, m] of [
    ['gt', options.gt],
    ['gte', options.gte],
    ['lt', options.lt],
    ['lte', options.lte],
    ['near', options.near],
    ['within', options.within],
    ['covers', options.covers],
    ['inside', options.inside],
  ] as const) {
```

`unit-store.ts`:

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The workspace's unit system (Settings → Units), client mirror — seeded by
// the shell's LocaleSync from GET /me/preferences' unit_system, persisted so a
// reload doesn't flash metric. Distances (geo widgets, Distance column) read it.

export type UnitSystem = 'metric' | 'imperial'

export interface UnitState {
  system: UnitSystem
  setSystem: (system: UnitSystem) => void
}

export const useUnitStore = create<UnitState>()(
  persist((set) => ({ system: 'metric', setSystem: (system) => set({ system }) }), { name: 'eerp-units', version: 1 }),
)
```

`distance-format.ts`:

```ts
import type { UnitSystem } from './unit-store'

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084

/** "742 m" / "12.4 km", or "164 ft" / "7.7 mi"; "—" when there is no distance. */
export function formatDistance(meters: number | null | undefined, system: UnitSystem, locale: string | null): string {
  if (meters == null || !Number.isFinite(meters)) return '—'
  const fmt = (n: number, digits: number) =>
    new Intl.NumberFormat(locale ?? undefined, { maximumFractionDigits: digits }).format(n)
  if (system === 'imperial') {
    const miles = meters / METERS_PER_MILE
    return miles < 0.1 ? `${fmt(meters * FEET_PER_METER, 0)} ft` : `${fmt(miles, 1)} mi`
  }
  return meters < 1000 ? `${fmt(meters, 0)} m` : `${fmt(meters / 1000, 1)} km`
}
```

`index.ts`: export `useUnitStore`, `type UnitSystem`, `formatDistance`, `type GeoJSONGeometry`, `useOSMSuggestions`, `type OSMSuggestion`.

`address-widget.tsx`: add `lat: number | null` and `lon: number | null` to `OSMSuggestion`, and `export` both `OSMSuggestion` and `useOSMSuggestions`.

Shell OSM route: `NominatimResult` gains `lat?: string; lon?: string`; `OSMSuggestion` gains `lat: number | null; lon: number | null`; in `toSuggestion`:

```ts
    lat: result.lat != null && Number.isFinite(Number(result.lat)) ? Number(result.lat) : null,
    lon: result.lon != null && Number.isFinite(Number(result.lon)) ? Number(result.lon) : null,
```

`preferences.ts`: add `unit_system?: 'metric' | 'imperial'` to the preferences type. `LocaleSync.tsx`, beside the currency seeding:

```ts
    if (preferences.unit_system) useUnitStore.getState().setSystem(preferences.unit_system)
```

- [ ] **Step 4: Run the tests**

Run: `cd core-front/packages/core-front && npx vitest run && npx tsc --noEmit -p . && npx -y pnpm@12.4.2 build && cd ../../apps/shell && npx vitest run app/api/integrations src/components && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front
rtk git commit -m "feat(front): geo/distance field types, geo list params, unit store"
```

---

### Task 9: Map widgets `geo/point` and `geo/shape`

**Files:**
- Modify: `core-front/packages/core-front/package.json` (`leaflet@^1.9.4`, devDependency `@types/leaflet`)
- Create: `core-front/packages/core-front/src/views/geo-map.tsx` (shared map hook)
- Create: `core-front/packages/core-front/src/views/geo-widgets.tsx`
- Create: `core-front/packages/core-front/src/views/geo-widgets.test.tsx`
- Modify: `core-front/packages/core-front/src/views/widgets.tsx:742-773` (registry)
- Modify: `core-front/apps/shell/app/layout.tsx` (`import 'leaflet/dist/leaflet.css'`)

**Interfaces:**
- Consumes: `GeoJSONGeometry`, `useOSMSuggestions`, `ADDRESS_SUFFIXES` (Task 8), `WidgetProps`.
- Produces: `GeoPointWidget`, `GeoShapeWidget` (registered as `'geo/point'`, `'geo/shape'`); `useLeafletMap(container: RefObject<HTMLDivElement | null>, interactive: boolean): { L: typeof import('leaflet') | null; map: import('leaflet').Map | null }`.

- [ ] **Step 1: Add Leaflet**

Edit `core-front/packages/core-front/package.json` dependencies: `"leaflet": "^1.9.4"`; devDependencies: `"@types/leaflet": "^1.9.12"`. Then `cd core-front && npx -y pnpm@12.4.2 install`.

- [ ] **Step 2: Write the failing tests (Leaflet mocked)**

```tsx
// core-front/packages/core-front/src/views/geo-widgets.test.tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Leaflet: records handlers so tests can "click" the map and "drag" a marker.
const handlers: Record<string, (e: { latlng: { lat: number; lng: number } }) => void> = {}
const markers: { latlng: { lat: number; lng: number }; on: Record<string, () => void>; removed: boolean }[] = []
const polygons: { latlngs: unknown; removed: boolean }[] = []
vi.mock('leaflet', () => {
  const map = {
    setView: vi.fn().mockReturnThis(),
    fitBounds: vi.fn(),
    on: (evt: string, fn: (e: { latlng: { lat: number; lng: number } }) => void) => { handlers[evt] = fn },
    remove: vi.fn(),
  }
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    divIcon: vi.fn(() => ({})),
    marker: vi.fn((latlng: [number, number]) => {
      const m = { latlng: { lat: latlng[0], lng: latlng[1] }, on: {} as Record<string, () => void>, removed: false }
      markers.push(m)
      return {
        addTo: vi.fn().mockReturnThis(),
        on: (evt: string, fn: () => void) => { m.on[evt] = fn; return undefined },
        getLatLng: () => m.latlng,
        setLatLng: (ll: [number, number]) => { m.latlng = { lat: ll[0], lng: ll[1] } },
        remove: () => { m.removed = true },
      }
    }),
    polygon: vi.fn((latlngs: unknown) => {
      const p = { latlngs, removed: false }
      polygons.push(p)
      return { addTo: vi.fn().mockReturnThis(), remove: () => { p.removed = true }, getBounds: () => ({}) }
    }),
    polyline: vi.fn(() => ({ addTo: vi.fn().mockReturnThis(), remove: vi.fn(), getBounds: () => ({}) })),
  }
  return { default: L, ...L }
})

import { GeoPointWidget, GeoShapeWidget } from './geo-widgets'

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k]
  markers.length = 0
  polygons.length = 0
})

describe('GeoPointWidget', () => {
  it('places the point where the map is clicked', async () => {
    const onChange = vi.fn()
    render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={onChange} />)
    await waitFor(() => expect(handlers.click).toBeDefined())
    act(() => handlers.click({ latlng: { lat: 48.85, lng: 2.35 } }))
    expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [2.35, 48.85] })
  })

  it('renders an empty map for a record with no location (Review Focus 2)', async () => {
    render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(handlers.click).toBeDefined())
    expect(markers).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull()
  })

  it('clears the point', async () => {
    const onChange = vi.fn()
    render(
      <GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={{ type: 'Point', coordinates: [2.35, 48.85] }} onChange={onChange} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('locates from the sibling address through the geocoder', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ label: 'x', lat: 45.76, lon: 4.83 }] })))
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(
      <GeoPointWidget
        field={{ name: 'geo_location', type: 'geo', widgetOptions: { address: 'address' } }}
        value={null}
        onChange={onChange}
        draft={{ address_number: 1, address_street: 'Rue X', address_zip_code: '69001', address_city: 'Lyon', address_country: 'France' }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /locate from address/i }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ type: 'Point', coordinates: [4.83, 45.76] }))
    expect(String(fetchMock.mock.calls[0][0])).toContain(encodeURIComponent('1 Rue X, 69001 Lyon, France'))
    vi.unstubAllGlobals()
  })

  it('is inert when disabled', async () => {
    const onChange = vi.fn()
    render(<GeoPointWidget field={{ name: 'geo_location', type: 'geo' }} value={null} onChange={onChange} disabled />)
    await waitFor(() => expect(markers).toHaveLength(0))
    expect(handlers.click).toBeUndefined()
  })
})

describe('GeoShapeWidget', () => {
  it('adds vertices on click and emits a closed polygon from 3 vertices', async () => {
    const onChange = vi.fn()
    render(<GeoShapeWidget field={{ name: 'service_zone', type: 'geo', widget: 'shape' }} value={null} onChange={onChange} />)
    await waitFor(() => expect(handlers.click).toBeDefined())
    act(() => handlers.click({ latlng: { lat: 48, lng: 2 } }))
    act(() => handlers.click({ latlng: { lat: 48, lng: 3 } }))
    expect(onChange).not.toHaveBeenCalled() // 2 vertices: not a polygon yet
    act(() => handlers.click({ latlng: { lat: 49, lng: 3 } }))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'Polygon', coordinates: [[[2, 48], [3, 48], [3, 49], [2, 48]]] })
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd core-front/packages/core-front && npx vitest run src/views/geo-widgets.test.tsx`
Expected: FAIL — `./geo-widgets` not found.

- [ ] **Step 4: Implement the map hook**

```tsx
// core-front/packages/core-front/src/views/geo-map.tsx
'use client'
import { useEffect, useState, type RefObject } from 'react'
import type * as Leaflet from 'leaflet'

type L = typeof Leaflet

/** OpenStreetMap tiles (no key). Their usage policy forbids heavy use: fine for
 * an ERP's form maps; a busy public site should point this at its own tiles. */
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; OpenStreetMap contributors'
/** Whole-world view for a map with nothing on it yet. */
export const WORLD: [number, number] = [20, 0]

/** A pin with no image assets (bundlers mangle Leaflet's default icon paths). */
export function pinIcon(L: L): Leaflet.DivIcon {
  return L.divIcon({
    className: 'eerp-geo-pin',
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#1976d2;border:2px solid #fff;box-shadow:0 0 2px #0008"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

/**
 * Mounts a Leaflet map in `container` (client-only: Leaflet touches `window`
 * at import, so it is imported lazily here, never at module top level).
 * Non-interactive maps can't be dragged or zoomed — read-only forms.
 */
export function useLeafletMap(container: RefObject<HTMLDivElement | null>, interactive: boolean) {
  const [state, setState] = useState<{ L: L | null; map: Leaflet.Map | null }>({ L: null, map: null })
  useEffect(() => {
    let map: Leaflet.Map | null = null
    let cancelled = false
    void import('leaflet').then((mod) => {
      const L = ((mod as unknown as { default?: L }).default ?? mod) as L
      if (cancelled || !container.current) return
      map = L.map(container.current, {
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: interactive,
        keyboard: interactive,
        zoomControl: interactive,
      }).setView(WORLD, 2)
      L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map)
      setState({ L, map })
    })
    return () => {
      cancelled = true
      map?.remove()
    }
  }, [container, interactive])
  return state
}
```

- [ ] **Step 5: Implement the widgets**

```tsx
// core-front/packages/core-front/src/views/geo-widgets.tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type * as Leaflet from 'leaflet'
import { useT } from '../i18n/translate'
import { useOSMSuggestions, type OSMSuggestion } from './address-widget'
import { ADDRESS_SUFFIXES, type GeoJSONGeometry } from './descriptor'
import { pinIcon, useLeafletMap } from './geo-map'
import type { WidgetProps } from './widgets'

type LonLat = [number, number]
const MAP_SX = { height: 280, borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider' }

function asPoint(value: unknown): LonLat | null {
  const v = value as GeoJSONGeometry | null
  return v && v.type === 'Point' ? v.coordinates : null
}

/** "12 Rue X, 75001 Paris, France" from an address field's sibling columns. */
function addressLine(draft: Record<string, unknown> | undefined, prefix: string): string {
  const get = (s: (typeof ADDRESS_SUFFIXES)[number]) => String(draft?.[`${prefix}_${s}`] ?? '').trim()
  const street = [get('number'), get('street')].filter(Boolean).join(' ')
  const city = [get('zip_code'), get('city')].filter(Boolean).join(' ')
  return [street, get('complement'), city, get('state'), get('country')].filter(Boolean).join(', ')
}

async function geocode(q: string): Promise<LonLat | null> {
  const res = await fetch(`/api/integrations/osm/search?q=${encodeURIComponent(q)}`).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json()) as { results?: OSMSuggestion[] }
  const hit = body.results?.find((r) => r.lat != null && r.lon != null)
  return hit ? [hit.lon as number, hit.lat as number] : null
}

/** geo/point — a draggable marker; click to place; address search; locate. */
export function GeoPointWidget({ field, value, onChange, disabled, draft }: WidgetProps) {
  const t = useT()
  const container = useRef<HTMLDivElement | null>(null)
  const { L, map } = useLeafletMap(container, !disabled)
  const marker = useRef<Leaflet.Marker | null>(null)
  const point = asPoint(value)
  const { options, search } = useOSMSuggestions()
  const [locating, setLocating] = useState(false)
  const addressPrefix = typeof field.widgetOptions?.address === 'string' ? field.widgetOptions.address : null

  const set = (ll: LonLat | null) => onChange(ll ? { type: 'Point', coordinates: ll } : null)

  // Map clicks place the point (editable maps only).
  useEffect(() => {
    if (!map || disabled) return
    map.on('click', (e: Leaflet.LeafletMouseEvent) => set([e.latlng.lng, e.latlng.lat]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, disabled])

  // Keep the marker in sync with the value.
  useEffect(() => {
    if (!L || !map) return
    if (!point) {
      marker.current?.remove()
      marker.current = null
      return
    }
    const latlng: [number, number] = [point[1], point[0]]
    if (marker.current) marker.current.setLatLng(latlng)
    else {
      marker.current = L.marker(latlng, { icon: pinIcon(L), draggable: !disabled }).addTo(map)
      marker.current.on('dragend', () => {
        const ll = marker.current?.getLatLng()
        if (ll) set([ll.lng, ll.lat])
      })
    }
    map.setView(latlng, Math.max(map.getZoom?.() ?? 13, 13))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, map, point?.[0], point?.[1], disabled])

  const locate = async () => {
    if (!addressPrefix) return
    setLocating(true)
    const found = await geocode(addressLine(draft as Record<string, unknown> | undefined, addressPrefix))
    setLocating(false)
    if (found) set(found)
  }

  return (
    <Stack spacing={1}>
      {!disabled && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Autocomplete
            sx={{ flex: 1 }}
            size="small"
            options={options}
            filterOptions={(o) => o}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
            onInputChange={(_, q, reason) => reason === 'input' && search(q)}
            onChange={(_, o) => o && typeof o !== 'string' && o.lat != null && o.lon != null && set([o.lon, o.lat])}
            renderInput={(params) => <TextField {...params} label={t('Search an address')} />}
          />
          {addressPrefix && (
            <Button variant="outlined" size="small" onClick={() => void locate()} disabled={locating}>
              {t('Locate from address')}
            </Button>
          )}
          {point && (
            <Button size="small" onClick={() => set(null)}>
              {t('Clear')}
            </Button>
          )}
        </Stack>
      )}
      <Box ref={container} sx={MAP_SX} data-testid="geo-map" />
      {point && (
        <Typography variant="caption" color="text.secondary">
          {point[1].toFixed(6)}, {point[0].toFixed(6)}
        </Typography>
      )}
    </Stack>
  )
}

/** The outer ring of a Polygon value, without its closing repeat. */
function ringOf(value: unknown): LonLat[] {
  const v = value as GeoJSONGeometry | null
  if (!v || v.type !== 'Polygon') return []
  const ring = v.coordinates[0] ?? []
  return ring.slice(0, Math.max(ring.length - 1, 0))
}

/** geo/shape — a minimal polygon editor: click adds a vertex, drag moves one,
 * clicking a vertex removes it. Stored lines/multipolygons show read-only. */
export function GeoShapeWidget({ value, onChange, disabled }: WidgetProps) {
  const t = useT()
  const container = useRef<HTMLDivElement | null>(null)
  const { L, map } = useLeafletMap(container, !disabled)
  const [vertices, setVertices] = useState<LonLat[]>(() => ringOf(value))
  const layers = useRef<{ remove: () => void }[]>([])
  const editable = !disabled && (value == null || (value as GeoJSONGeometry).type === 'Polygon')

  const emit = (next: LonLat[]) => {
    setVertices(next)
    if (next.length >= 3) onChange({ type: 'Polygon', coordinates: [[...next, next[0]]] })
    else if (next.length === 0) onChange(null)
  }

  useEffect(() => {
    if (!map || !editable) return
    map.on('click', (e: Leaflet.LeafletMouseEvent) => {
      setVertices((prev) => {
        const next: LonLat[] = [...prev, [e.latlng.lng, e.latlng.lat]]
        if (next.length >= 3) onChange({ type: 'Polygon', coordinates: [[...next, next[0]]] })
        return next
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, editable])

  // Redraw the polygon and its vertex handles.
  useEffect(() => {
    if (!L || !map) return
    for (const layer of layers.current) layer.remove()
    layers.current = []
    const v = value as GeoJSONGeometry | null
    if (v && v.type !== 'Polygon') {
      const shape =
        v.type === 'LineString'
          ? L.polyline(v.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])).addTo(map)
          : v.type === 'MultiPolygon'
            ? L.polygon(v.coordinates.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [lat, lon] as [number, number])))).addTo(map)
            : null
      if (shape) {
        layers.current.push(shape)
        map.fitBounds(shape.getBounds())
      }
      return
    }
    if (vertices.length >= 2) {
      const poly = L.polygon(vertices.map(([lon, lat]) => [lat, lon] as [number, number])).addTo(map)
      layers.current.push(poly)
    }
    if (editable) {
      vertices.forEach(([lon, lat], i) => {
        const handle = L.marker([lat, lon], { icon: pinIcon(L), draggable: true }).addTo(map)
        handle.on('dragend', () => {
          const ll = handle.getLatLng()
          emit(vertices.map((p, j) => (j === i ? [ll.lng, ll.lat] : p)))
        })
        handle.on('click', () => emit(vertices.filter((_, j) => j !== i)))
        layers.current.push(handle)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, map, vertices, editable, value])

  return (
    <Stack spacing={1}>
      {editable && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {t('Click the map to add points; click a point to remove it.')}
          </Typography>
          {vertices.length > 0 && (
            <Button size="small" onClick={() => emit([])}>
              {t('Clear')}
            </Button>
          )}
        </Stack>
      )}
      <Box ref={container} sx={MAP_SX} data-testid="geo-map" />
    </Stack>
  )
}
```

Register in `widgets.tsx` `WIDGET_COMPONENTS`: `'geo/point': GeoPointWidget, 'geo/shape': GeoShapeWidget,` (import from `./geo-widgets`). Add `import 'leaflet/dist/leaflet.css'` at the top of `core-front/apps/shell/app/layout.tsx`.

- [ ] **Step 6: Run the tests**

Run: `cd core-front/packages/core-front && npx vitest run src/views/geo-widgets.test.tsx && npx tsc --noEmit -p .`
Expected: PASS. Adjust only the fake-Leaflet surface in the test if a method the widget calls (e.g. `getZoom`) is missing.

- [ ] **Step 7: Commit**

```bash
rtk git add core-front
rtk git commit -m "feat(front): geo/point and geo/shape map widgets (Leaflet)"
```

---

### Task 10: Distance widget and zone relation list

**Files:**
- Create: `core-front/apps/shell/app/api/geo/distance/route.ts` (+ `route.test.ts`, `// @vitest-environment node`)
- Create: `core-front/packages/core-front/src/views/distance-widget.tsx` (+ `.test.tsx`)
- Modify: `core-front/packages/core-front/src/views/widgets.tsx` (register `'distance/meters'`)
- Modify: `core-front/packages/core-front/src/views/relation-widgets.tsx:1227-1345,1455-1490` (`inside` relations)
- Test: `core-front/packages/core-front/src/views/relation-widgets.test.tsx` (append)

**Interfaces:**
- Consumes: `formatDistance`, `useUnitStore` (Task 8), `WidgetProps.entity/recordId/draft`; Go `GET /api/v1/geo/distance` (Task 5).
- Produces: BFF `GET /api/geo/distance?from=&to=` → Go's body/status; `DistanceWidget`; one2many-by-zone list rendering.

- [ ] **Step 1: Write the failing tests**

```tsx
// core-front/packages/core-front/src/views/distance-widget.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DistanceWidget } from './distance-widget'
import { useUnitStore } from './unit-store'

const field = {
  name: 'distance_to_event',
  type: 'distance' as const,
  widgetOptions: {
    from: { entity: 'contact', id: 'contact_id', field: 'geo_location' },
    to: { entity: 'event', id: 'event_id', field: 'geo_location' },
  },
}

afterEach(() => vi.unstubAllGlobals())

describe('DistanceWidget', () => {
  it('asks the BFF for the two references and shows km', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ meters: 12400 })))
    vi.stubGlobal('fetch', fetchMock)
    useUnitStore.getState().setSystem('metric')
    render(<DistanceWidget field={field} value={null} onChange={vi.fn()} entity="event_booking" recordId="b1" draft={{ contact_id: 'c1', event_id: 'e1' }} />)
    expect(await screen.findByText('12.4 km')).toBeTruthy()
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `/api/geo/distance?from=${encodeURIComponent('contact:c1:geo_location')}&to=${encodeURIComponent('event:e1:geo_location')}`,
    )
  })

  it('shows miles for an imperial workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ meters: 12400 }))))
    useUnitStore.getState().setSystem('imperial')
    render(<DistanceWidget field={field} value={null} onChange={vi.fn()} draft={{ contact_id: 'c1', event_id: 'e1' }} />)
    expect(await screen.findByText('7.7 mi')).toBeTruthy()
  })

  it('shows — without a reference and never calls Go (Review Focus 2)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<DistanceWidget field={field} value={null} onChange={vi.fn()} draft={{ contact_id: null, event_id: 'e1' }} />)
    expect(screen.getByText('—')).toBeTruthy()
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
  })

  it('shows — when Go answers null (unlocated)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ meters: null }))))
    render(<DistanceWidget field={field} value={null} onChange={vi.fn()} draft={{ contact_id: 'c1', event_id: 'e1' }} />)
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
  })
})
```

Append to `relation-widgets.test.tsx` (reuse the file's existing ops stub/render helper for `RelationListWidget`):

```tsx
it('lists rows inside the record zone for an inside relation', async () => {
  const list = vi.fn(async () => [])
  renderRelationList({
    field: {
      name: 'zone_contacts',
      type: 'relation',
      readOnly: true,
      relation: { entity: 'contact', kind: 'one2many', inside: { field: 'geo_location', zone: 'service_zone' }, labelField: 'name' },
    },
    entity: 'company',
    recordId: 'co1',
    ops: { list },
  }) // the file's existing helper; pass `entity` through to the widget props
  await waitFor(() => expect(list).toHaveBeenCalled())
  expect(list.mock.calls[0][1]).toMatchObject({ inside: { geo_location: 'company:co1:service_zone' } })
  expect(screen.queryByRole('button', { name: /create a new/i })).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd core-front/packages/core-front && npx vitest run src/views/distance-widget.test.tsx src/views/relation-widgets.test.tsx`
Expected: FAIL — module missing; inside relation throws "requires inverseField".

- [ ] **Step 3: Implement**

`distance-widget.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Typography from '@mui/material/Typography'
import { useI18nStore } from '../i18n/store'
import { formatDistance } from './distance-format'
import { useUnitStore } from './unit-store'
import type { WidgetProps } from './widgets'

interface Side {
  entity: string
  /** Draft field holding the record id; omitted = this record. */
  id?: string
  field: string
}

function ref(side: unknown, draft: Record<string, unknown> | undefined, recordId: string | null | undefined): string | null {
  const s = side as Side | undefined
  if (!s?.entity || !s.field) return null
  const id = s.id ? draft?.[s.id] : recordId
  return typeof id === 'string' && id !== '' ? `${s.entity}:${id}:${s.field}` : null
}

/** distance/meters — the database's distance between two geo values (ADR-029). */
export function DistanceWidget({ field, draft, recordId }: WidgetProps) {
  const system = useUnitStore((s) => s.system)
  const locale = useI18nStore((s) => s.locale)
  const from = ref(field.widgetOptions?.from, draft as Record<string, unknown> | undefined, recordId)
  const to = ref(field.widgetOptions?.to, draft as Record<string, unknown> | undefined, recordId)
  const [meters, setMeters] = useState<number | null>(null)

  useEffect(() => {
    setMeters(null)
    if (!from || !to) return
    let cancelled = false
    fetch(`/api/geo/distance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ meters: number | null }>) : { meters: null }))
      .then((body) => !cancelled && setMeters(body.meters ?? null))
      .catch(() => !cancelled && setMeters(null))
    return () => {
      cancelled = true
    }
  }, [from, to])

  return <Typography>{formatDistance(meters, system, locale)}</Typography>
}
```

(if `useI18nStore` lives elsewhere, import it from where `widgets.tsx` imports it.)

Register `'distance/meters': DistanceWidget` in `WIDGET_COMPONENTS`.

`apps/shell/app/api/geo/distance/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { ApiError, apiRequest } from '@eerp/core-front/server'

// BFF for the distance widget: forwards to Go's GET /api/v1/geo/distance with
// the session Bearer; Go authorizes both references. Errors relay Go's status.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const qs = new URLSearchParams({ from: params.get('from') ?? '', to: params.get('to') ?? '' })
  try {
    return NextResponse.json(await apiRequest<{ meters: number | null }>('GET', `/geo/distance?${qs}`))
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 502
    return NextResponse.json({ meters: null }, { status })
  }
}
```

with `route.test.ts` (node environment; mock `@eerp/core-front/server`'s `apiRequest`) asserting the forwarded path `/geo/distance?from=contact%3Ac1%3Ageo_location&to=…` and that an `ApiError(404)` relays 404.

`relation-widgets.tsx` `RelationListWidget`:

```tsx
  const inverseField = rel.inverseField ?? null
  const insideRef = rel.inside && entity && recordId ? `${entity}:${recordId}:${rel.inside.zone}` : null
```

(destructure `entity` from props), the fetch options:

```tsx
    const options = rel.inside
      ? insideRef
        ? { inside: { [rel.inside.field]: insideRef }, pageSize: EMBED_PAGE_SIZE }
        : null
      : { filter: { [inverseField as string]: recordId }, pageSize: EMBED_PAGE_SIZE }
    if (!options) return
```

and the create button/wizards render only when `inverseField` is set (`{inverseField && !disabled && (...)}` around the existing create `Button` and both wizards). Every other `inverseField` use already sits in those branches or in `relatedColumns(..., [inverseField])` — pass `inverseField ? [inverseField] : []` there. Update the `rel.inverseField` read at line 1519 (summary path) the same way (`if (!rel.inverseField) return` before its fetch).

- [ ] **Step 4: Run the tests**

Run: `cd core-front/packages/core-front && npx vitest run && npx tsc --noEmit -p . && npx -y pnpm@12.4.2 build && cd ../../apps/shell && npx vitest run app/api/geo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front
rtk git commit -m "feat(front): distance widget and zone-based relation lists"
```

---

### Task 11: Search-bar geo filters and the Distance column

**Files:**
- Modify: `core-front/packages/core-front/src/views/search-bar.tsx` (`toListOptions`, value editors for near/inside/covers)
- Create: `core-front/packages/core-front/src/views/geo-filter-inputs.tsx`
- Modify: `core-front/packages/core-front/src/views/renderers.tsx` (tree: a Distance column when rows carry `_distance_m`)
- Test: `core-front/packages/core-front/src/views/search-bar.test.tsx`, `core-front/packages/core-front/src/views/renderers.test.tsx` (append)

**Interfaces:**
- Consumes: `FilterOperator` near/inside/covers, `EntityListOptions` geo maps (Task 8), `useOSMSuggestions`, `formatDistance`, `useUnitStore`.
- Produces: `toListOptions` maps `near` → `near` (+`within` when the value has a radius), `inside` → `inside`, `covers` → `covers`; `GeoCenterInput` (`value: string` "lon,lat[,m]", `onChange`), `ZoneRecordInput` (`zones: {entity, field, label}[]`, `value` "table:id:col", `onChange`).

- [ ] **Step 1: Write the failing tests**

Append to `search-bar.test.tsx` (it already tests `toListOptions` through the bar or directly — export `toListOptions` for testing if it isn't):

```tsx
describe('geo filters → list options', () => {
  it('near with a radius adds within; inside and covers pass through', () => {
    expect(
      toListOptions(
        [
          { field: 'geo_location', op: 'near', value: '2.35,48.85,10000' },
          { field: 'geo_location', op: 'inside', value: 'company:co1:service_zone' },
          { field: 'service_zone', op: 'covers', value: '2.35,48.85' },
        ],
        200,
      ),
    ).toEqual({
      pageSize: 200,
      near: { geo_location: '2.35,48.85' },
      within: { geo_location: '2.35,48.85,10000' },
      inside: { geo_location: 'company:co1:service_zone' },
      covers: { service_zone: '2.35,48.85' },
    })
  })
  it('near without a radius only orders', () => {
    expect(toListOptions([{ field: 'geo_location', op: 'near', value: '2.35,48.85' }], 200)).toEqual({
      pageSize: 200,
      near: { geo_location: '2.35,48.85' },
    })
  })
})
```

Append to `renderers.test.tsx`: rendering the tree with rows `[{ id: '1', name: 'A', _distance_m: 1500 }]` and the unit store metric shows a "Distance" column header and `1.5 km`; rows without `_distance_m` show no such column.

- [ ] **Step 2: Run to verify they fail**

Run: `cd core-front/packages/core-front && npx vitest run src/views/search-bar.test.tsx src/views/renderers.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`search-bar.tsx` `toListOptions` gains:

```ts
      case 'near': {
        const parts = (f.value ?? '').split(',')
        if (parts.length < 2) break
        ;(options.near ??= {})[f.field] = `${parts[0]},${parts[1]}`
        if (parts.length === 3 && parts[2] !== '') (options.within ??= {})[f.field] = f.value as string
        break
      }
      case 'inside':
        ;(options.inside ??= {})[f.field] = f.value ?? ''
        break
      case 'covers':
        ;(options.covers ??= {})[f.field] = f.value ?? ''
        break
```

`geo-filter-inputs.tsx`:

```tsx
'use client'
import { useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT } from '../i18n/translate'
import { useOSMSuggestions } from './address-widget'
import { useRelationOps } from './relation-ops'

/** A filter center ("lon,lat") picked from an address or the browser's
 * position, plus an optional radius in km (stored as meters: "lon,lat,m"). */
export function GeoCenterInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  const { options, search } = useOSMSuggestions()
  const [lon, lat, m] = value.split(',')
  const center = lon && lat ? `${lon},${lat}` : ''
  const set = (c: string, meters: string) => onChange(c ? (meters ? `${c},${meters}` : c) : '')
  const myLocation = () =>
    navigator.geolocation?.getCurrentPosition((pos) => set(`${pos.coords.longitude},${pos.coords.latitude}`, m ?? ''))
  return (
    <Stack spacing={1}>
      <Autocomplete
        size="small"
        options={options}
        filterOptions={(o) => o}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
        onInputChange={(_, q, reason) => reason === 'input' && search(q)}
        onChange={(_, o) => o && typeof o !== 'string' && o.lon != null && o.lat != null && set(`${o.lon},${o.lat}`, m ?? '')}
        renderInput={(params) => <TextField {...params} label={t('Near an address')} />}
      />
      <Button size="small" onClick={myLocation}>{t('Use my location')}</Button>
      <TextField
        size="small"
        type="number"
        label={t('Within (km, optional)')}
        value={m ? String(Number(m) / 1000) : ''}
        onChange={(e) => set(center, e.target.value === '' ? '' : String(Math.round(Number(e.target.value) * 1000)))}
      />
    </Stack>
  )
}

/** A zone record ("table:id:column") among the zone entities a point field declares. */
export function ZoneRecordInput({
  zones,
  value,
  onChange,
}: {
  zones: { entity: string; field: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  const t = useT()
  const ops = useRelationOps()
  const [entity, setEntity] = useState(zones[0]?.entity ?? '')
  const zone = zones.find((z) => z.entity === entity)
  const [records, setRecords] = useState<{ id: string; name?: string }[]>([])
  const find = (q: string) =>
    ops?.list(entity, { search: { name: q }, pageSize: 20 }).then((rows) => setRecords(rows as { id: string; name?: string }[]))
  return (
    <Stack spacing={1}>
      {zones.length > 1 && (
        <TextField select size="small" label={t('Zone of')} value={entity} onChange={(e) => setEntity(e.target.value)}>
          {zones.map((z) => <MenuItem key={z.entity} value={z.entity}>{t(z.label)}</MenuItem>)}
        </TextField>
      )}
      <Autocomplete
        size="small"
        options={records}
        getOptionLabel={(r) => r.name ?? r.id}
        onInputChange={(_, q) => void find(q)}
        onChange={(_, r) => r && zone && onChange(`${zone.entity}:${r.id}:${zone.field}`)}
        renderInput={(params) => <TextField {...params} label={t(zone?.label ?? 'Zone')} />}
      />
    </Stack>
  )
}
```

In the search bar's add-filter builder, where the value input renders per operator, add: `near` → `<GeoCenterInput value={draftValue} onChange={setDraftValue} />`; `inside` → `<ZoneRecordInput zones={(field.widgetOptions?.zones as …) ?? []} … />` (hide the `inside` operator from `operatorsFor` when the field declares no `zones`); `covers` → `<GeoCenterInput>` without the radius (pass a `radius={false}` prop that hides the km field). Chip labels for geo filters: `near` → "Near (≤ 10 km)" / "Near", `inside` → "Inside zone", `covers` → "Covers point".

`renderers.tsx` tree columns: when the first loaded row has `_distance_m` (key present), append a column `{ field: '_distance_m', headerName: t('Distance'), sortable: false, valueFormatter: (v) => formatDistance(v as number | null, system, locale) }` (`system` from `useUnitStore`, `locale` from the i18n store the file already uses).

- [ ] **Step 4: Run the tests**

Run: `cd core-front/packages/core-front && npx vitest run && npx tsc --noEmit -p . && npx -y pnpm@12.4.2 build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front
rtk git commit -m "feat(front): near/inside/covers search filters and Distance column"
```

---

### Task 12: Website — "nearest to me" event list

**Files:**
- Create: `core-front/apps/shell/app/api/site-events/upcoming/route.ts` (+ `route.test.ts`, node env)
- Modify: `core-front/apps/shell/src/website/types.ts:50-52` (`EventListConfig.nearest`)
- Modify: `core-front/apps/shell/src/website/blocks/EventList.tsx` (re-fetch by position, distance on cards)
- Modify: `core-front/apps/shell/app/app/website/pages/[id]/design/BlockSettings.tsx:284-293` (checkbox)
- Test: `core-front/apps/shell/src/website/blocks/event-list.test.tsx` (append)

**Interfaces:**
- Consumes: Go `GET /api/v1/public/events/upcoming?near=` (Task 7), `formatDistance`.
- Produces: BFF `GET /api/site-events/upcoming?limit=&near=` → Go's JSON (`{data}`), client-only; `EventListConfig.nearest?: boolean`; `UpcomingEvent.distance_m?: number | null`.

- [ ] **Step 1: Write the failing tests**

Append to `event-list.test.tsx`:

```tsx
describe('nearest to me', () => {
  const events = [
    { id: 'a', name: 'Far', kind: 'sessions', next_session_at: '2026-11-01T10:00:00Z', seats_left: 3 },
    { id: 'b', name: 'Close', kind: 'sessions', next_session_at: '2026-12-01T10:00:00Z', seats_left: 3 },
  ]

  it('re-fetches by distance when the visitor shares a position', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { longitude: 2.35, latitude: 48.85 } }) } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ ...events[1], distance_m: 1200 }, { ...events[0], distance_m: 90000 }] })))
    vi.stubGlobal('fetch', fetchMock)
    render(<EventList config={{ nearest: true, limit: 12 }} events={events} />)
    await waitFor(() => expect(screen.getAllByRole('heading')[0].textContent).toContain('Close'))
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/site-events/upcoming?limit=12&near=2.35%2C48.85')
    expect(screen.getByText(/1\.2 km/)).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('keeps the soonest-first order when the visitor refuses (Review Focus 5)', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_ok: unknown, err: (e: unknown) => void) => err({ code: 1 }) } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<EventList config={{ nearest: true }} events={events} />)
    await waitFor(() => expect(screen.getAllByRole('heading')[0].textContent).toContain('Far'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    vi.unstubAllGlobals()
  })
})
```

(adjust `getAllByRole('heading')` to however the existing tests read card titles.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd core-front/apps/shell && npx vitest run src/website/blocks/event-list.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts`: `export interface EventListConfig { display?: 'cards' | 'list'; limit?: number; detail_slug?: string; nearest?: boolean }` (+ doc: "`nearest`: ask the visitor's position and list nearest first; refused → soonest first").

`route.ts`:

```ts
import { NextResponse } from 'next/server'
import { forwardedFor } from '@/lib/bff'

// GET /api/site-events/upcoming?limit=&near= — the event list's "nearest to me"
// re-fetch, from the visitor's browser. Relays Go's public endpoint with the
// visitor IP (Go rate-limits /public per IP); never cached (positions vary).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const qs = new URLSearchParams()
  const limit = params.get('limit')
  const near = params.get('near')
  if (limit) qs.set('limit', limit)
  if (near) qs.set('near', near)
  const res = await fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/public/events/upcoming?${qs}`, {
    cache: 'no-store',
    headers: await forwardedFor(),
  }).catch(() => null)
  if (!res) return NextResponse.json({ data: [] }, { status: 502 })
  return NextResponse.json(await res.json().catch(() => ({ data: [] })), { status: res.status })
}
```

`EventList.tsx`: add `distance_m?: number | null` to `UpcomingEvent`; inside the component:

```tsx
  const [shown, setShown] = useState(events)
  const system = useUnitStore((s) => s.system)
  useEffect(() => {
    setShown(events)
    if (!config.nearest || !navigator.geolocation) return
    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const qs = new URLSearchParams({ limit: String(config.limit ?? 12), near: `${pos.coords.longitude},${pos.coords.latitude}` })
        fetch(`/api/site-events/upcoming?${qs}`)
          .then((res) => (res.ok ? (res.json() as Promise<{ data: UpcomingEvent[] }>) : null))
          .then((body) => !cancelled && body && setShown(body.data))
          .catch(() => undefined)
      },
      () => undefined, // refused/unavailable: keep soonest-first, no message
      { maximumAge: 600_000, timeout: 10_000 },
    )
    return () => {
      cancelled = true
    }
  }, [events, config.nearest, config.limit])
```

render `shown` instead of `events`, and append to each card's "when" line `ev.distance_m != null ? ` · ${formatDistance(ev.distance_m, system, locale)}` : ''`.

`BlockSettings.tsx` `case 'event_list'`: add `check('nearest', 'Nearest to me (asks the visitor's location)'),` after the limit field, and update the hint to `'Lists published events with a future session (appointment events too), soonest first — or nearest first when the visitor shares their location.'`.

- [ ] **Step 4: Run the tests**

Run: `cd core-front/apps/shell && npx vitest run src/website app/api/site-events && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core-front
rtk git commit -m "feat(website): event list 'nearest to me'"
```

---

### Task 13: First users — company, contact, event, property, booking

**Files:**
- Modify: `core/internal/company/models.go` (`GeoLocation`, `ServiceZone`)
- Modify: `core/modules/contact/internal/contacts.go` (`GeoLocation`)
- Modify: `core/modules/event/models.go:36-55` (`GeoLocation`)
- Modify: `core/modules/propertymanagement/module.go:34-60` (`GeoLocation`, `Parcel`)
- Modify: `core-front/apps/shell/app/app/settings/company/descriptors.ts:36` (point + zone + zone contacts)
- Modify: `core/modules/contact/views/contact_views.ts` (point field)
- Modify: `core/modules/event/views/EventViews.ts:49-55,243-262` (event point; booking distance)
- Modify: `core/modules/propertymanagement/views/property_management_views.ts:313` (point + parcel)
- Modify: i18n — `core-front/apps/shell/i18n/{shell.pot,fr.po}` and each touched module's `i18n/{<name>.pot,fr.po}` for the new labels
- Test: `core/internal/app/geo_test.go` (create); `core/internal/app/website_test.go` (`TestPublicUpcomingEvents` near case); module view tests (`contact_views.test.ts`, `EventViews.test.ts`, `propertymanagement_views.test.ts`) gain descriptor assertions

**Interfaces:**
- Consumes: everything above.
- Produces: columns `company.geo_location`, `company.service_zone`, `contact.geo_location`, `event.geo_location`, `property_management.geo_location`, `property_management.parcel` (all gist-indexed, nullable).

- [ ] **Step 1: Write the failing app test**

```go
// core/internal/app/geo_test.go
package app

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// Real routes, real modules: a company zone, contacts inside/outside it, the
// inside[] list, a booking's distance, and the public nearest-events order.
func TestGeo_FirstUsers(t *testing.T) {
	c := buildApp(t) // the package's existing app builder (admin token)
	ctx := context.Background()
	var cleanup []string
	t.Cleanup(func() {
		for _, q := range cleanup {
			_, _ = c.a.db.DB.Exec(ctx, q)
		}
	})
	create := func(path string, body map[string]any) string {
		t.Helper()
		code, resp := c.do(http.MethodPost, path, body)
		if code != http.StatusCreated && code != http.StatusOK {
			t.Fatalf("POST %s: %d %s", path, code, resp)
		}
		return decode(t, resp)["id"].(string)
	}
	pt := func(lon, lat float64) map[string]any { return map[string]any{"type": "Point", "coordinates": []float64{lon, lat}} }
	idf := map[string]any{"type": "Polygon", "coordinates": [][][]float64{{{1.4, 48.1}, {3.6, 48.1}, {3.6, 49.3}, {1.4, 49.3}, {1.4, 48.1}}}}

	tag := "geo-" + uuid.NewString()[:8]
	in := create("/api/v1/contact", map[string]any{"name": tag + "-in", "email": tag + "in@x.fr", "geo_location": pt(2.35, 48.85)})
	out := create("/api/v1/contact", map[string]any{"name": tag + "-out", "email": tag + "out@x.fr", "geo_location": pt(4.83, 45.76)})
	cleanup = append(cleanup, "DELETE FROM contact WHERE id IN ('"+in+"','"+out+"')")

	code, resp := c.do(http.MethodGet, "/api/v1/company?page_size=1", nil)
	if code != http.StatusOK {
		t.Fatalf("company list: %d %s", code, resp)
	}
	company := decode(t, resp)["data"].([]any)[0].(map[string]any)["id"].(string)
	if code, resp := c.do(http.MethodPut, "/api/v1/company/"+company, map[string]any{"name": decode(t, resp)["data"].([]any)[0].(map[string]any)["name"], "service_zone": idf}); code != http.StatusOK {
		t.Fatalf("company zone: %d %s", code, resp)
	}
	cleanup = append(cleanup, "UPDATE company SET service_zone = NULL WHERE id = '"+company+"'")

	code, resp = c.do(http.MethodGet, "/api/v1/contact?search[name]="+tag+"&inside[geo_location]=company:"+company+":service_zone", nil)
	rows := decode(t, resp)["data"].([]any)
	if code != http.StatusOK || len(rows) != 1 || rows[0].(map[string]any)["id"] != in {
		t.Errorf("contacts inside zone = %d %v", code, rows)
	}

	code, resp = c.do(http.MethodGet, "/api/v1/geo/distance?from=contact:"+in+":geo_location&to=contact:"+out+":geo_location", nil)
	if m, _ := decode(t, resp)["meters"].(float64); code != http.StatusOK || m < 390000 || m > 395000 {
		t.Errorf("distance = %d %s", code, resp)
	}
}
```

(`buildApp`/`c.do`/`decode` — use the helpers `app_test.go` already defines; if the package only has `buildSiteApp`, use it.)

In `TestPublicUpcomingEvents`, publish `geo_location` too (`"fields":["name","kind","location","timezone","picture","geo_location"]`), create `sessions` with `"geo_location": {"type":"Point","coordinates":[4.83,45.76]}` and a second published sessions event at Paris 72 h out, then assert `?near=2.35,48.85&limit=50` lists the Paris one first with `distance_m` < 1000 and the Lyon one next, and `?near=999,0` is 400.

In the same file, add `TestPublicGeoParams`: publish `company` with `{"fields":["name","geo_location"]}` (restore the old selection in cleanup), then anonymous `GET /api/v1/public/company?near[geo_location]=2.35,48.85` → 200; `?covers[service_zone]=2.35,48.85` → 400 (`service_zone` unpublished); `?inside[geo_location]=company:<id>:service_zone` → 400 (references refused publicly).

- [ ] **Step 2: Run to verify it fails**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -run 'TestGeo_FirstUsers|TestPublicUpcomingEvents' ./internal/app/`
Expected: FAIL — unknown fields / columns.

- [ ] **Step 3: Add the Go fields**

```go
// core/internal/company/models.go — after the address columns
	// GeoLocation and ServiceZone (ADR-029): where the company is, and the
	// area it serves ("contacts inside our zone").
	GeoLocation *orm.GeoPoint `db:"geo_location,index=gist"`
	ServiceZone *orm.GeoShape `db:"service_zone,index=gist"`
```

```go
// core/modules/contact/internal/contacts.go
	// GeoLocation: where the contact is (picked on a map or geocoded).
	GeoLocation *orm.GeoPoint `db:"geo_location,index=gist" json:"geo_location"`
```

```go
// core/modules/event/models.go — after Location
	// GeoLocation: the event's position, beside the free-text Location; lets
	// the website list events nearest to the visitor.
	GeoLocation *orm.GeoPoint `db:"geo_location,index=gist" json:"geo_location"`
```

```go
// core/modules/propertymanagement/module.go — after the address columns
	// GeoLocation (the building) and Parcel (its land) — ADR-029.
	GeoLocation *orm.GeoPoint `db:"geo_location,index=gist" json:"geo_location"`
	Parcel      *orm.GeoShape `db:"parcel,index=gist" json:"parcel"`
```

(add `"core/orm"` imports where missing.)

- [ ] **Step 4: Add the descriptors**

Company (`descriptors.ts`, after the `address` field):

```ts
    { name: 'geo_location', label: 'Location', type: 'geo', widget: 'point', widgetOptions: { address: 'address' } },
    { name: 'service_zone', label: 'Service zone', type: 'geo', widget: 'shape' },
    {
      name: 'zone_contacts',
      label: 'Contacts in this zone',
      type: 'relation',
      readOnly: true,
      relation: { entity: 'contact', kind: 'one2many', inside: { field: 'geo_location', zone: 'service_zone' }, labelField: 'name', formPath: '/contacts/:id' },
    },
```

Contact (`contact_views.ts`): `Contact` interface gains `geo_location?: GeoJSONGeometry | null`; `fields` gains

```ts
  {
    name: 'geo_location',
    label: 'Location',
    type: 'geo',
    widget: 'point',
    widgetOptions: { zones: [{ entity: 'company', field: 'service_zone', label: 'Company service zone' }] },
  },
```

and the list view keeps its columns as they are (the geo field in `fields` is not a tree column if the tree's `fields` list is separate; if `fields` is shared by the tree, give the tree `fields.filter((f) => f.type !== 'geo')` so the map never renders in a grid cell).

Event (`EventViews.ts` `eventFormFields`, after `location`): `{ name: 'geo_location', label: 'Map position', type: 'geo', widget: 'point' },`. Booking (`bookingFormFields`, after `contact_id`):

```ts
  {
    name: 'distance_to_event',
    label: 'Distance attendee → event',
    type: 'distance',
    widgetOptions: {
      from: { entity: 'contact', id: 'contact_id', field: 'geo_location' },
      to: { entity: 'event', id: 'event_id', field: 'geo_location' },
    },
  },
```

Property (`property_management_views.ts`, after the `address` field at line 313):

```ts
  { name: 'geo_location', label: 'Location', type: 'geo', widget: 'point', widgetOptions: { address: 'address' } },
  { name: 'parcel', label: 'Parcel', type: 'geo', widget: 'shape' },
```

Add the module view-test assertions (each file's existing descriptor tests): the new fields exist with the declared type/widget and validate (`resolveWidget` doesn't throw).

- [ ] **Step 5: Translations**

Add every new UI string (field labels above, plus Task 9–12's `'Search an address'`, `'Locate from address'`, `'Clear'`, `'Click the map to add points; click a point to remove it.'`, `'Near an address'`, `'Use my location'`, `'Within (km, optional)'`, `'Zone of'`, `'Zone'`, `'Distance'`, `'near'`, `'inside zone of'`, `'covers'`, `'Nearest to me (asks the visitor's location)'`, the event_list hint) to `core-front/apps/shell/i18n/shell.pot` (empty msgstr) and `fr.po` (French), and module labels to each module's own `i18n/<module>.pot` + `fr.po`. French: Location → Emplacement; Service zone → Zone de service; Contacts in this zone → Contacts dans cette zone; Map position → Position sur la carte; Distance attendee → event → Distance participant → événement; Parcel → Parcelle; Search an address → Rechercher une adresse; Locate from address → Localiser depuis l'adresse; Clear → Effacer; Click the map… → Cliquez sur la carte pour ajouter des points ; cliquez sur un point pour le retirer.; Near an address → Près d'une adresse; Use my location → Utiliser ma position; Within (km, optional) → Dans un rayon de (km, facultatif); Zone of → Zone de; Distance → Distance; near → près de; inside zone of → dans la zone de; covers → contient; Company service zone → Zone de service de l'entreprise; Nearest to me (asks the visitor's location) → Les plus proches (demande la position du visiteur).

- [ ] **Step 6: Run everything**

Run: `cd core && CONFIG=$PWD/../eerp-config.json go test -count=1 -timeout 1200s ./... && cd ../core-front && npx -y pnpm@12.4.2 -r --no-bail --workspace-concurrency=1 test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
rtk git add core core-front
rtk git commit -m "feat: geo fields on company, contact, event, property; booking distance"
```

---

### Task 14: Documentation

**Files:**
- Create: `docs/adr/ADR-029-geographic-fields.md`
- Modify: `CLAUDE.md` (ORM section: geo types + list params; `internal/` list: `internal/geo`; Configuration: PostGIS image)
- Modify: `core-front/CLAUDE.md` (field types `geo`/`distance`, search bar geo filters, website event_list `nearest`)
- Modify: `core/orm/README.md` (new "Geographic fields" section after "Row locking")

- [ ] **Step 1: Write ADR-029**

Sections: **Context** (the four use cases), **Decision** (PostGIS geography 4326; text I/O — EWKB hex out/EWKT in — and why not a pgx codec: the extension must exist before the pool's type map loads, and a dbmanage switch would need re-registration; GeoJSON geometry on the wire; `near`/`within`/`covers`/`inside` params; references `table:id:col` resolved in the ORM behind `access.WithReadCheck`; `/api/v1/geo/distance`; Leaflet + OSM tiles), **Consequences** (image switch; `CREATE EXTENSION` needs a privileged role on managed DBs; OSM tile policy), a Mermaid sequence diagram of `GET /api/v1/contact?inside[geo_location]=company:<id>:service_zone` (handler → permission middleware stamping the read check → crud resolveGeoRef → SQL `ST_Covers((SELECT …), geo_location)`), and **Pitfalls** (copy the spec's list: [lon, lat] order; boundary covered; `_distance_m` computed; prod image switch; `inside` refused on public routes; a point without `index=gist` makes `near` scan the table).

- [ ] **Step 2: Update CLAUDE.md, core-front/CLAUDE.md and the ORM README**

`CLAUDE.md`: in the generic list endpoint paragraph, add the four geo params with one sentence each and the 400/404 rules; add an `internal/geo/` bullet (distance endpoint); in the ORM usage block, a `Location *orm.GeoPoint \`db:"geo_location,index=gist"\`` example; in Configuration, note the `postgis/postgis:18-3.6` image and that boot creates the extension. `core-front/CLAUDE.md`: extend the field-types/widgets table with `geo/point`, `geo/shape`, `distance/meters`, the relation `inside` option, the search bar's geo filters and Distance column, the unit store, and the website event_list `nearest` option (BFF `/api/site-events/upcoming`). `core/orm/README.md`: "Geographic fields" — declaring, GeoJSON wire format, the params table, `orm.GeoDistance`, pitfalls; link ADR-029.

- [ ] **Step 3: Commit**

```bash
rtk git add docs/adr/ADR-029-geographic-fields.md CLAUDE.md core-front/CLAUDE.md core/orm/README.md
rtk git commit -m "docs: ADR-029 geographic fields"
```
