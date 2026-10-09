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
