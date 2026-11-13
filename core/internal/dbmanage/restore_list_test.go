package dbmanage

import (
	"strings"
	"testing"
)

// A database created by an older PostGIS image carries postgis_tiger_geocoder,
// which current images don't ship: its entries, schema and config data are
// left out; everything else is kept as is.
func TestRestoreList_SkipsUnavailableExtensions(t *testing.T) {
	toc := strings.Join([]string{
		";",
		"; Archive created at 2026-11-13 10:00:00 UTC",
		"12; 2615 19385 SCHEMA - tiger postgres",
		"11; 2615 19184 SCHEMA - topology postgres",
		"2; 3079 18102 EXTENSION - postgis ",
		"7058; 0 0 COMMENT - EXTENSION postgis ",
		"6; 3079 19386 EXTENSION - postgis_tiger_geocoder ",
		"7059; 0 0 COMMENT - EXTENSION postgis_tiger_geocoder ",
		"5; 3079 19185 EXTENSION - postgis_topology ",
		"300; 1259 20000 TABLE public users postgres",
		"5323; 0 19392 TABLE DATA tiger geocode_settings postgres",
		"5324; 0 19753 TABLE DATA tiger pagc_gaz postgres",
		"5400; 0 20000 TABLE DATA public users postgres",
		"",
	}, "\n")
	available := map[string]bool{"postgis": true, "postgis_topology": true}

	list, skipped := restoreList(toc, available)
	if len(skipped) != 1 || skipped[0] != "postgis_tiger_geocoder" {
		t.Fatalf("skipped = %v", skipped)
	}
	// Exactly the tiger lines are commented out; header comments stay comments.
	in, out := strings.Split(toc, "\n"), strings.Split(list, "\n")
	for i, l := range in {
		want := l
		if strings.Contains(l, "tiger") {
			want = ";" + l
		}
		if out[i] != want {
			t.Errorf("line %d: got %q, want %q", i, out[i], want)
		}
	}

	if got, skipped := restoreList(toc, map[string]bool{"postgis": true, "postgis_topology": true, "postgis_tiger_geocoder": true}); got != toc || skipped != nil {
		t.Error("a server with every extension restores the list unchanged")
	}
}

func TestTocEntry(t *testing.T) {
	for _, tc := range []struct{ line, typ, schema string }{
		{"5323; 0 19392 TABLE DATA tiger geocode_settings postgres", "TABLE DATA", "tiger"},
		{"12; 2615 19385 SCHEMA - tiger postgres", "SCHEMA", "-"},
		{"7059; 0 0 COMMENT - EXTENSION postgis_tiger_geocoder ", "COMMENT", "-"},
		{"; Archive created at", "", ""},
		{"", "", ""},
	} {
		if typ, schema, _ := tocEntry(tc.line); typ != tc.typ || schema != tc.schema {
			t.Errorf("%q: got %q %q", tc.line, typ, schema)
		}
	}
}
