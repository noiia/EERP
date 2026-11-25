package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestDiffSchemas(t *testing.T) {
	ref := Schema{"a": "1", "b": "2", "c": "3"}
	d := diffSchemas(ref, Schema{"a": "1", "b": "9", "d": "4"})
	if !reflect.DeepEqual(d.Missing, []string{"c"}) || !reflect.DeepEqual(d.Changed, []string{"b: want 2 got 9"}) ||
		!reflect.DeepEqual(d.Extra, []string{"d"}) || !d.Failed() {
		t.Errorf("bad diff %+v", d)
	}
	if diffSchemas(ref, Schema{"a": "1", "b": "2", "c": "3", "x": "y"}).Failed() {
		t.Error("extras alone must not fail")
	}
}

func TestLoadSchema_FreshDatabasesMatch(t *testing.T) {
	cfg := testConfig(t)
	a, b := snapshot(t, cfg, freshDB(t, cfg)), snapshot(t, cfg, freshDB(t, cfg))
	d := diffSchemas(a, b)
	if len(d.Missing)+len(d.Changed)+len(d.Extra) > 0 {
		t.Fatalf("fresh databases differ: %+v", d)
	}
	if _, ok := a["column:users.email"]; !ok {
		t.Error("column:users.email missing")
	}
	for k := range a {
		if strings.Contains(k, "spatial_ref_sys") || strings.Contains(k, "function:st_") {
			t.Errorf("extension object leaked: %s", k)
		}
	}
}

func TestLoadSchema_DetectsDrift(t *testing.T) {
	cfg := testConfig(t)
	ref := snapshot(t, cfg, freshDB(t, cfg))
	got := snapshot(t, cfg, freshDB(t, cfg), "ALTER TABLE contact DROP COLUMN phone", "CREATE INDEX trgm_x ON users (email)")
	d := diffSchemas(ref, got)
	if !reflect.DeepEqual(d.Missing, []string{"column:contact.phone"}) || !reflect.DeepEqual(d.Extra, []string{"index:trgm_x"}) {
		t.Errorf("bad drift diff %+v", d)
	}
}
