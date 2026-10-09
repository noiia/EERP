package orm_test

import (
	"reflect"
	"testing"
	"time"

	"core/orm"
	"core/orm/model"
)

// jsonbFixture proves a slice-typed field (e.g. sale.Invoice's Lines, an
// array of line-item objects the invoice PDF report table renders) migrates
// as JSONB rather than falling through reflectTypeToSQL's TEXT default —
// the one gap that stood between the generic CRUD's already-dynamic
// map[string]any read/write path (orm/internal/crud) and actually storing a
// module's own array-valued column.
type jsonbFixture struct {
	model.BaseModel
	Lines *[]map[string]any `db:"lines"`
}

func TestMigrationFieldsForTable_SliceFieldIsJSONB(t *testing.T) {
	if err := orm.Register[jsonbFixture](); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("jsonb_fixture")
	if !ok {
		t.Fatal("jsonb_fixture table not registered")
	}

	for _, f := range fields {
		if f.Column != "lines" {
			continue
		}
		if f.SQLType != "JSONB" {
			t.Errorf("lines SQLType = %q, want JSONB", f.SQLType)
		}
		if !f.Nullable {
			t.Error("lines should be nullable (pointer-to-slice, same convention as every other optional column)")
		}
		return
	}
	t.Fatal("lines column not found in migration fields")
}

// extendFixture is extended through ExtendSchema below: extension columns
// migrate typed (TEXT when untyped) and nullable, never NOT NULL.
type extendFixture struct {
	model.BaseModel
	Name string `db:"name"`
}

func TestMigrationFieldsForTable_ExtendedColumns(t *testing.T) {
	if err := orm.Register[extendFixture](); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := orm.ExtendSchema("extend_fixture", []orm.SchemaField{
		{Column: "points", Type: reflect.TypeFor[int]()},
		{Column: "seen_at", Type: reflect.TypeFor[time.Time]()},
		{Column: "note"},
	}); err != nil {
		t.Fatalf("extend: %v", err)
	}
	fields, _ := orm.MigrationFieldsForTable("extend_fixture")
	want := map[string]string{"points": "INTEGER", "seen_at": "TIMESTAMPTZ", "note": "TEXT", "name": "TEXT"}
	for _, f := range fields {
		sqlType, ok := want[f.Column]
		if !ok {
			continue
		}
		delete(want, f.Column)
		if f.SQLType != sqlType {
			t.Errorf("%s SQLType = %q, want %q", f.Column, f.SQLType, sqlType)
		}
		if wantNullable := f.Column != "name"; f.Nullable != wantNullable {
			t.Errorf("%s Nullable = %v, want %v", f.Column, f.Nullable, wantNullable)
		}
	}
	if len(want) > 0 {
		t.Errorf("columns missing from migration: %v", want)
	}
}

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
