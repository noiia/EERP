# Geographic fields — design

Date: 2026-10-09 · Status: approved in conversation, pending spec review

## Goal

Let any module declare **geographic points and zones** on its records and let the
**database** answer the geographic questions — nearest first, within a radius, inside a zone,
distance between two records — for the ERP and the public website. The field types and the
widgets are framework features; four existing entities are their first users.

Use cases (all four in scope):

1. Sort / filter lists by distance ("contacts within 10 km, nearest first").
2. Distance between two records ("attendee → event").
3. Website: "events nearest to me".
4. Zones: "contacts inside our service zone", "which companies serve this point".

Non-goals (v1): routing/travel time, drawing lines in the editor (lines are stored and shown,
not drawn), clustering many markers on a list map view, reverse geocoding.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Engine | **PostGIS** (`postgis/postgis:18-3.6`) | accurate globe distances in meters, point-in-polygon, GiST-indexed KNN; zones (use case 4) rule out `earthdistance`/plain lat-lon |
| Column types | `geography(Point,4326)`, `geography(Geometry,4326)` | meters natively, no projection choice for callers |
| Wire format | **GeoJSON geometry** | standard; Leaflet and Nominatim speak it |
| DB I/O | text: EWKB hex out, EWKT in | no pgx codec registration (which would need the extension before the pool connects), no SQL rewriting |
| Map | Leaflet + OSM tiles, own minimal polygon editor | no API key; the only new frontend dependency |

## 1. Storage and ORM

### Database
- `compose.yml`, `compose.prod.yml` and the CI Postgres service use `postgis/postgis:18-3.6`
  (Postgres 18 + PostGIS; data directory format unchanged, existing volumes reused).
- Boot creates the extension: `CREATE EXTENSION IF NOT EXISTS postgis`, run by
  `internal/module`'s migration under the existing schema advisory lock, before any table DDL.
  It therefore also runs for `internal/dbmanage` create/switch (both re-run `Registry.Boot`).
  A restored dump carries its own `CREATE EXTENSION`.
- `core/Dockerfile`'s `pg_dump`/`pg_restore` need no change (PostGIS objects dump as SQL).

### Types — package `core/orm/geo`, re-exported by `core/orm`
- `orm.GeoPoint` — `struct{ Lon, Lat float64 }` → SQL `geography(Point,4326)`.
- `orm.GeoShape` — a geometry held as GeoJSON: `Polygon`, `MultiPolygon` or `LineString`
  → SQL `geography(Geometry,4326)`.
- Declared like any field; always pointers (nullable):
  `Location *orm.GeoPoint \`db:"geo_location,index=gist"\``. `index=gist` already exists.
- `reflectTypeToSQL` maps both types; `ExtendSchema` fields may use them through
  `SchemaField.Type`.
- Both types implement `sql.Scanner` (EWKB hex text → value) and `driver.Valuer`
  (value → EWKT `SRID=4326;POINT(lon lat)`), so typed repositories work unchanged.
- Generic CRUD (`map[string]any`): a geo column is recognized by its registered Go type
  (`FieldMeta.GoType`). On read, `scanToMaps`' callers convert that column's text to a
  GeoJSON object; on write, a GeoJSON object in the body is validated and converted to EWKT.
- Validation (400 `VALIDATION_ERROR`): GeoJSON parses; geometry kind allowed for the type
  (Point for `GeoPoint`; Polygon/MultiPolygon/LineString for `GeoShape`); lon ∈ [-180, 180],
  lat ∈ [-90, 90]; polygon rings closed with ≥ 4 positions; ≤ 10 000 positions total.
- Conversions use `github.com/twpayne/go-geom` (`encoding/ewkbhex`, `encoding/wkt`,
  `encoding/geojson`).
- Group gating (ADR-013), the public scope (ADR-024) and tenant pinning apply to geo columns
  exactly as to any other column.

## 2. Querying

### Generic list params (`GET /api/v1/{table}`)

| Param | SQL | Effect |
|---|---|---|
| `near[<point col>]=<lon>,<lat>` | `ORDER BY col <-> ST_MakePoint(lon,lat)::geography`, select `ST_Distance(...) AS _distance_m` | nearest first; each row carries read-only `_distance_m` (NULL point → last, `_distance_m` null) |
| `within[<point col>]=<lon>,<lat>,<meters>` | `ST_DWithin(col, point, meters)` | radius filter (meters > 0, ≤ 20 000 000) |
| `covers[<shape col>]=<lon>,<lat>` | `ST_Covers(col, point)` | rows whose zone contains the point |
| `inside[<point col>]=<table>:<id>:<shape col>` | `ST_Covers((SELECT shape FROM table WHERE id=… AND tenant…), col)` | rows inside another record's zone |

- Columns go through `Repository.checkColumn` (existing whitelist + group gating + public
  scope); a geo param on a column of the wrong geo type, or a non-geo column, is a 400.
- `near` is the only ordering the generic list has; at most one `near` per request.
- `inside` permission: `PermissionMiddleware` stamps a read checker on the context —
  `access.WithReadCheck(ctx, func(table string) bool)` evaluating `<table>:<table>:read`
  for the caller's roles (lazy, memoized per request) — mirroring `WithGroups`, so
  `core/orm` never imports `auth`. The referenced table must be registered, readable by the
  caller, the record in the caller's tenant and not soft-deleted, and the shape column not
  gated for the caller. Any failure → 404 (existence is not leaked).
- The Redis read cache keys on SQL + args: geo queries cache with no change.
- `?distinct=` and `?aggregate=` ignore `near` (they don't page/order); filters still apply.

### Distance between two records
- `GET /api/v1/geo/distance?from=<table>:<id>:<col>&to=<table>:<id>:<col>` → `{"meters": n}`
  or `{"meters": null}` when either side is empty. `internal/geo` package; route permission
  derived as `geo:geo:read`; both references resolved with the same checks as `inside`.
- `ST_Distance(a, b)` on geography: point–point, point–zone (0 when inside, else distance to
  the zone's boundary), zone–zone.

### Public website
- `/api/v1/public/{table}` accepts `near`, `within`, `covers` on **published** columns;
  `inside` is refused (400) — it would reference arbitrary records.
- `GET /api/v1/public/events/upcoming` gains `?near=<lon>,<lat>`: published events ordered by
  distance of `event.geo_location` (events without one after, then the existing order), each
  row with `distance_m`. Only when `geo_location` is published.
- nginx `Permissions-Policy`: `geolocation=()` → `geolocation=(self)` so the site can ask the
  visitor's position.

## 3. Frontend

### Field type `geo`
`descriptor.ts`: `FieldType` gains `'geo'`, `FIELD_WIDGETS.geo = ['point', 'shape']`.

- **`point`** — Leaflet map (client-only dynamic import; OSM tiles), one draggable marker,
  click to place; an address search box (geocodes free text through the BFF
  `/api/integrations/osm/search`, which now also returns `lat`/`lon`); "Locate from address"
  when `widgetOptions.address` names a sibling `type: 'address'` prefix (geocodes its 7
  columns); "Clear"; editable lat/lon readout. Search/locate are hidden when the OSM connector
  is disabled.
- **`shape`** — same map with a minimal polygon editor: click adds a vertex, drag moves one,
  a vertex's popup removes it, "Clear". Stored LineStrings render read-only.
- Read-only forms render a static map (no interaction). Value in the draft is the GeoJSON
  object, `null` when empty.
- CSP unchanged: Leaflet's CSS is bundled, tiles load under `img-src https:`.

### Field type `distance` (computed, `store: false`)
- Widget `meters`. Options:
  `{from: {relation?: '<many2one field>', field: '<geo field>'}, to: {relation?, field}}` —
  each side is a geo field of this record, or of the record a many2one points at.
- Fetches the BFF route `/api/geo/distance` (→ Go `/api/v1/geo/distance`) whenever the
  resolved references change; renders `12.4 km`, or miles when the workspace unit system
  (`units.system`) is imperial; "—" when either side is empty.

### List search bar
Shown only for entities with a geo field (from the descriptor):
- **Near** — center: an address (Nominatim), "my location" (browser), or a record of an entity
  with a point; optional radius → `near` + `within`; the list gains a "Distance" column
  (`_distance_m`, formatted like the distance widget).
- **Inside zone of** — pick a record of an entity with a shape field → `inside`.
- Both are ordinary filter chips: removable, and stored in saved filters' config.

### Website
- `event_list` block option `nearest: boolean` ("Nearest to me"): the block asks the browser's
  position; granted → `?near=`, each card shows its distance; refused/unavailable → the
  existing soonest-first order.

## 4. First users

| Entity | Fields | UI |
|---|---|---|
| company (`internal/company`) | `geo_location` point, `service_zone` shape | point "Locate from address"; a "Contacts in this zone" link → contact list with `inside` |
| contact | `geo_location` point | point widget (search box; contact has no address) |
| event | `geo_location` point (beside free-text `location`) | point widget |
| property (`propertymanagement`) | `geo_location` point, `parcel` shape | point "Locate from address" |
| event_booking | `distance` field "Distance attendee → event" (`from: contact_id → geo_location`, `to: event_id → geo_location`) | distance widget |

All new columns are nullable; existing rows are untouched. `event.geo_location` is added to the
event table's public-capable fields.

## 5. Testing

- **ORM unit:** EWKB/EWKT/GeoJSON round trips; validation table (bad JSON, wrong kind, out of
  range, open ring, too many positions); `ToSQL` of each geo param; `checkColumn` refusals.
- **ORM DB (fresh tenant):** each list param against real rows (ordering + `_distance_m`,
  radius, covers, inside); `inside`/distance refusals (unreadable table, other tenant, gated
  column → 404); typed repo Scan/Value; extension created on an empty database.
- **App:** contact/company/event create + read through real routes with geo values; public
  `near` on a published column, refused on an unpublished one; `events/upcoming?near=`.
- **Frontend:** point/shape widgets with a mocked Leaflet (place, drag, clear, locate, search);
  distance widget (km/mi/empty); search bar Near/Inside chips → query params; event_list
  nearest option (granted/refused).
- Full Go and pnpm suites stay green.

## 6. Documentation

- New `docs/adr/ADR-029-geographic-fields.md`: why PostGIS, the text I/O decision, wire
  format, params, permission model for references, pitfalls.
- `CLAUDE.md` (ORM section + list params), `core-front/CLAUDE.md` (field types/widgets, search
  bar, website block), `core/orm/README.md` (geo fields + querying).

## Pitfalls to document

- Coordinates are `[lon, lat]` in GeoJSON and EWKT — the reverse of the habitual "lat, lon".
- A point exactly on a zone's boundary is covered (`ST_Covers`, not `ST_Contains`).
- `_distance_m` is a computed key: never writable, absent without `near`.
- Production: the image switch is the only deployment step; the extension is created at boot.
