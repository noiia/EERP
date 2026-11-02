package website

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"core/internal/website/formtarget"
)

func init() {
	formtarget.RegisterFormTarget("fs_person", "name", "email", "age", "born", "ok", "home_number", "home_complement",
		"home_street", "home_zip_code", "home_city", "home_state", "home_country", "parent_id", "score")
}

// fsTypes is the column type table of fs_person (what orm.ColumnGoType answers).
var fsTypes = map[string]string{"age": "*int", "born": "*time.Time", "ok": "bool", "home_number": "*int", "score": "float64"}

func fsColType(col string) string {
	if t, ok := fsTypes[col]; ok {
		return t
	}
	return "string"
}

func TestParseFieldValue(t *testing.T) {
	day := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		field   formtarget.FormField
		raw     string
		want    map[string]any
		display string
		wantErr bool
	}{
		{"text trimmed", formtarget.FormField{Type: "text", Column: "name"}, `"  Ann  "`, map[string]any{"name": "Ann"}, "Ann", false},
		{"text too long", formtarget.FormField{Type: "text", Column: "name"}, `"` + strings.Repeat("a", 2001) + `"`, nil, "", true},
		{"long allows more", formtarget.FormField{Type: "long", Column: "name"}, `"` + strings.Repeat("a", 2001) + `"`, map[string]any{"name": strings.Repeat("a", 2001)}, strings.Repeat("a", 2001), false},
		{"text not a string", formtarget.FormField{Type: "text", Column: "name"}, `{"a":1}`, nil, "", true},
		{"optional empty", formtarget.FormField{Type: "text", Column: "name"}, `""`, nil, "", false},
		{"optional absent", formtarget.FormField{Type: "text", Column: "name"}, ``, nil, "", false},
		{"required blank", formtarget.FormField{Type: "text", Column: "name", Required: true}, `"   "`, nil, "", true},
		{"required null", formtarget.FormField{Type: "text", Column: "name", Required: true}, `null`, nil, "", true},
		{"email", formtarget.FormField{Type: "email", Column: "email"}, `"a@b.io"`, map[string]any{"email": "a@b.io"}, "a@b.io", false},
		{"email with display name", formtarget.FormField{Type: "email", Column: "email"}, `"A <a@b.io>"`, nil, "", true},
		{"email garbage", formtarget.FormField{Type: "email", Column: "email"}, `"nope"`, nil, "", true},
		{"phone too long", formtarget.FormField{Type: "phone", Column: "name"}, `"` + strings.Repeat("1", 51) + `"`, nil, "", true},
		{"number into int", formtarget.FormField{Type: "number", Column: "age"}, `42`, map[string]any{"age": int64(42)}, "42", false},
		{"numeric string into int", formtarget.FormField{Type: "number", Column: "age"}, `"7"`, map[string]any{"age": int64(7)}, "7", false},
		{"fraction into int", formtarget.FormField{Type: "number", Column: "age"}, `4.5`, nil, "", true},
		{"int overflow", formtarget.FormField{Type: "number", Column: "age"}, `1e12`, nil, "", true},
		{"number into float", formtarget.FormField{Type: "number", Column: "score"}, `4.5`, map[string]any{"score": 4.5}, "4.5", false},
		{"number into text", formtarget.FormField{Type: "number", Column: "name"}, `4.5`, map[string]any{"name": "4.5"}, "4.5", false},
		{"not a number", formtarget.FormField{Type: "number", Column: "age"}, `"x"`, nil, "", true},
		{"date", formtarget.FormField{Type: "date", Column: "born"}, `"2026-11-02"`, map[string]any{"born": day}, "2026-11-02", false},
		{"date bad format", formtarget.FormField{Type: "date", Column: "born"}, `"02/11/2026"`, nil, "", true},
		{"date into text", formtarget.FormField{Type: "date", Column: "name"}, `"2026-11-02"`, map[string]any{"name": "2026-11-02"}, "2026-11-02", false},
		{"checkbox", formtarget.FormField{Type: "checkbox", Column: "ok"}, `true`, map[string]any{"ok": true}, "yes", false},
		{"checkbox string", formtarget.FormField{Type: "checkbox", Column: "ok"}, `"true"`, nil, "", true},
		{"required checkbox unticked", formtarget.FormField{Type: "checkbox", Column: "ok", Required: true}, `false`, nil, "", true},
		{"text into bool column", formtarget.FormField{Type: "text", Column: "ok"}, `"maybe"`, nil, "", true},
		{"select option", formtarget.FormField{Type: "select", Column: "name", Options: []string{"A", "B"}}, `"B"`, map[string]any{"name": "B"}, "B", false},
		{"select other", formtarget.FormField{Type: "select", Column: "name", Options: []string{"A", "B"}}, `"C"`, nil, "", true},
		{"address", formtarget.FormField{Type: "address", Column: "home"}, `{"number":3,"street":"Main","city":"Paris","evil":"x"}`,
			map[string]any{"home_number": int64(3), "home_street": "Main", "home_city": "Paris"}, "3 Main Paris", false},
		{"address required without city", formtarget.FormField{Type: "address", Column: "home", Required: true}, `{"street":"Main"}`, nil, "", true},
		{"address bad number", formtarget.FormField{Type: "address", Column: "home"}, `{"number":-1}`, nil, "", true},
		{"address not an object", formtarget.FormField{Type: "address", Column: "home"}, `"Main"`, nil, "", true},
		{"address empty", formtarget.FormField{Type: "address", Column: "home"}, `{"street":""}`, nil, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, display, err := parseFieldValue(tc.field, json.RawMessage(tc.raw), fsColType)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if !reflect.DeepEqual(got, tc.want) && !(len(got) == 0 && len(tc.want) == 0) {
				t.Errorf("values = %#v, want %#v", got, tc.want)
			}
			if display != tc.display {
				t.Errorf("display = %q, want %q", display, tc.display)
			}
		})
	}
}

func TestParseSubmission(t *testing.T) {
	cfg := formtarget.FormConfig{
		Targets: []formtarget.FormTargetSpec{{Table: "fs_person", Fixed: map[string]string{"age": "30"}}},
		Fields: []formtarget.FormField{
			{ID: "n", Label: "Name", Type: "text", Column: "name", Required: true},
			{ID: "e", Label: "Email", Type: "email", Column: "email", Required: true},
		},
	}
	colType := func(_, col string) (string, bool) { return fsColType(col), true }

	t.Run("valid, unknown keys ignored", func(t *testing.T) {
		sub, err := parseSubmission(cfg, map[string]json.RawMessage{
			"n": json.RawMessage(`"Ann"`), "e": json.RawMessage(`"a@b.io"`),
			"parent_id": json.RawMessage(`"00000000-0000-0000-0000-000000000001"`), "tenant_id": json.RawMessage(`"x"`),
		}, colType)
		if err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"name": "Ann", "email": "a@b.io", "age": int64(30)}
		if !reflect.DeepEqual(sub.cols[0], want) {
			t.Errorf("cols = %#v, want %#v", sub.cols[0], want)
		}
		if strings.Join(sub.lines[0], "; ") != "Name: Ann; Email: a@b.io" {
			t.Errorf("lines = %v", sub.lines[0])
		}
	})
	t.Run("every bad field is named", func(t *testing.T) {
		_, err := parseSubmission(cfg, map[string]json.RawMessage{"e": json.RawMessage(`"bad"`)}, colType)
		var fe *formFieldError
		if !errors.As(err, &fe) || !reflect.DeepEqual(fe.ids, []string{"n", "e"}) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a fixed value its column can't hold makes the form unusable", func(t *testing.T) {
		bad := cfg
		bad.Targets = []formtarget.FormTargetSpec{{Table: "fs_person", Fixed: map[string]string{"age": "old"}}}
		if _, err := parseSubmission(bad, nil, colType); !errors.Is(err, errFormUnusable) {
			t.Fatalf("err = %v, want errFormUnusable", err)
		}
	})
}
