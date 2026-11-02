package website

import (
	"core/internal/website/formtarget"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func init() { formtarget.RegisterFormTarget("contact", "name", "email") }

func TestValidatePage(t *testing.T) {
	block := func(id, typ string, x, y, w, h int) map[string]any {
		return map[string]any{"id": id, "type": typ, "x": x, "y": y, "w": w, "h": h, "config": map[string]any{}}
	}
	formBlock := func(id string, cfg map[string]any) map[string]any {
		b := block(id, "form", 0, 0, 36, 10)
		b["config"] = cfg
		return b
	}
	tests := []struct {
		name    string
		body    map[string]any
		wantErr string // substring; "" = valid
	}{
		{"home page", map[string]any{"slug": "", "layout": []any{block("a", "text", 0, 0, 36, 6)}}, ""},
		{"simple slug", map[string]any{"slug": "products"}, ""},
		{"dashes and digits", map[string]any{"slug": "events-2026"}, ""},
		{"uppercase", map[string]any{"slug": "Products"}, "slug"},
		{"nested path", map[string]any{"slug": "a/b"}, "slug"},
		{"reserved app", map[string]any{"slug": "app"}, "reserved"},
		{"reserved api", map[string]any{"slug": "api"}, "reserved"},
		{"reserved settings", map[string]any{"slug": "settings"}, "reserved"},
		{"reserved appstore", map[string]any{"slug": "appstore"}, "reserved"},
		{"reserved force-password-change", map[string]any{"slug": "force-password-change"}, "reserved"},
		{"go module name", map[string]any{"slug": "crm"}, "reserved"},
		{"slug number", map[string]any{"slug": 5}, "string"},
		{"slug null", map[string]any{"slug": nil}, "string"},
		{"slug bool", map[string]any{"slug": true}, "string"},
		{"unknown block type", map[string]any{"layout": []any{block("a", "iframe", 0, 0, 1, 1)}}, "type"},
		{"duplicate block id", map[string]any{"layout": []any{block("a", "text", 0, 0, 1, 1), block("a", "text", 0, 1, 1, 1)}}, "duplicate"},
		{"negative x", map[string]any{"layout": []any{block("a", "text", -1, 0, 1, 1)}}, "x/y"},
		{"zero width", map[string]any{"layout": []any{block("a", "text", 0, 0, 0, 1)}}, "w/h"},
		{"wider than grid", map[string]any{"layout": []any{block("a", "text", 30, 0, 7, 1)}}, "36 columns"},
		{"layout not an array", map[string]any{"layout": "nope"}, "layout"},
		{"form block ok", map[string]any{"layout": []any{formBlock("f", map[string]any{
			"targets": []any{map[string]any{"table": "contact"}},
			"fields":  []any{map[string]any{"id": "n", "type": "text", "column": "name", "target": 0}},
		})}}, ""},
		{"form block writing users", map[string]any{"layout": []any{formBlock("f", map[string]any{
			"targets": []any{map[string]any{"table": "users"}},
		})}}, "not a form target"},
		{"form block unregistered column", map[string]any{"layout": []any{formBlock("f", map[string]any{
			"targets": []any{map[string]any{"table": "contact"}},
			"fields":  []any{map[string]any{"id": "n", "type": "text", "column": "tenant_id", "target": 0}},
		})}}, "not allowed"},
		{"form block without config", map[string]any{"layout": []any{formBlock("f", nil)}}, "target"},
		{"no slug key on update is fine", map[string]any{"title": "x"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePage(tt.body, func(n string) bool { return n == "crm" })
			if tt.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

// BlockTypes and the frontend's BLOCK_TYPES are one closed set written twice;
// a type known to only one side is either refused on save or never rendered.
func TestBlockTypes_MatchFrontend(t *testing.T) {
	src, err := os.ReadFile("../../../core-front/apps/shell/src/website/types.ts")
	if err != nil {
		t.Skipf("frontend source not available: %v", err)
	}
	m := regexp.MustCompile(`BLOCK_TYPES = \[([^\]]*)\]`).FindSubmatch(src)
	if m == nil {
		t.Fatal("BLOCK_TYPES not found in types.ts")
	}
	front := map[string]bool{}
	for _, q := range regexp.MustCompile(`'([a-z_]+)'`).FindAllSubmatch(m[1], -1) {
		front[string(q[1])] = true
	}
	if !maps.Equal(front, BlockTypes) {
		t.Errorf("frontend BLOCK_TYPES %v != Go BlockTypes %v", slices.Sorted(maps.Keys(front)), slices.Sorted(maps.Keys(BlockTypes)))
	}
}
