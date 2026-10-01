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
