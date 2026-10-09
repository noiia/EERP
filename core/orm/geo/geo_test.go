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

const polyHex = "0103000020E6100000010000000400000000000000000000000000000000000000000000000000F03F0000000000000000000000000000F03F000000000000F03F00000000000000000000000000000000"
const polyJSON = `{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}`

func TestShapeRoundTrip(t *testing.T) {
	s := geo.Shape{GeoJSON: json.RawMessage(polyJSON)}
	v, err := s.Value()
	if err != nil || v != "SRID=4326;POLYGON ((0 0, 1 0, 1 1, 0 0))" {
		t.Fatalf("value = %v, %v", v, err)
	}
	var back geo.Shape
	if err := back.Scan(polyHex); err != nil || string(back.GeoJSON) != polyJSON {
		t.Fatalf("scan = %s, %v", back.GeoJSON, err)
	}
	got, err := geo.GeoJSONFromDB([]byte(polyHex))
	if err != nil || string(got) != polyJSON {
		t.Fatalf("GeoJSONFromDB = %s, %v", got, err)
	}
	var p geo.Point
	if err := p.Scan(polyHex); err == nil {
		t.Error("Point.Scan of a polygon must fail")
	}
}

func TestShapeJSON(t *testing.T) {
	b, err := json.Marshal(geo.Shape{GeoJSON: json.RawMessage(polyJSON)})
	if err != nil || string(b) != polyJSON {
		t.Fatalf("marshal = %s, %v", b, err)
	}
	if b, _ := json.Marshal(geo.Shape{}); string(b) != "null" {
		t.Errorf("zero shape = %s", b)
	}
	var s geo.Shape
	if err := json.Unmarshal([]byte(polyJSON), &s); err != nil || string(s.GeoJSON) != polyJSON {
		t.Fatalf("unmarshal = %s, %v", s.GeoJSON, err)
	}
	for _, bad := range []string{
		`{"type":"Point","coordinates":[0,0]}`,
		`{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}`,
	} {
		if err := json.Unmarshal([]byte(bad), &s); !errors.Is(err, geo.ErrInvalid) {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
}

func TestEWKTFromGeoJSON_Edges(t *testing.T) {
	hole := `{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[2,2],[3,2],[3,3],[2,2]]]}`
	if _, err := geo.EWKTFromGeoJSON(geo.KindShape, []byte(hole)); err != nil {
		t.Errorf("polygon with hole: %v", err)
	}
	for _, bad := range []string{`{"type":"Polygon","coordinates":[]}`, `null`} {
		if _, err := geo.EWKTFromGeoJSON(geo.KindShape, []byte(bad)); !errors.Is(err, geo.ErrInvalid) {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
}

func TestParseRadius(t *testing.T) {
	for _, ok := range []string{"1", "20000000"} {
		if _, err := geo.ParseRadius(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"0", "-5", "20000001", "abc", "NaN"} {
		if _, err := geo.ParseRadius(bad); !errors.Is(err, geo.ErrInvalid) {
			t.Errorf("%q: err = %v", bad, err)
		}
	}
}
