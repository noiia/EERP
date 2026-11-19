package crud

import (
	"context"
	"testing"

	"core/orm/access"
	"core/orm/internal/registry"
)

func TestBuildResponse_GroupGating(t *testing.T) {
	meta := registry.TableMeta{
		Fields: []registry.FieldMeta{
			{Name: "id", Column: "id"},
			{Name: "name", Column: "name"},
			{Name: "salary", Column: "salary", Groups: []string{"hr_manager"}},
		},
	}
	row := map[string]any{"id": "1", "name": "Alice", "salary": 100000}

	tests := []struct {
		name       string
		ctx        context.Context
		wantSalary bool
	}{
		{"no groups stamped on the context (e.g. an internal call)", context.Background(), false},
		{"caller with an unrelated group", access.WithGroups(context.Background(), []string{"support"}), false},
		{"caller with the matching group", access.WithGroups(context.Background(), []string{"hr_manager"}), true},
		{"caller with multiple groups, one matching", access.WithGroups(context.Background(), []string{"support", "hr_manager"}), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := BuildResponse(tt.ctx, meta, row)
			_, gotSalary := out["salary"]
			if gotSalary != tt.wantSalary {
				t.Errorf("salary present = %v, want %v", gotSalary, tt.wantSalary)
			}
			if out["name"] != "Alice" {
				t.Errorf("ungated field 'name' must always pass through, got %v", out["name"])
			}
		})
	}
}

func TestBuildResponse_UngatedFieldsUnaffectedByEmptyGroups(t *testing.T) {
	meta := registry.TableMeta{
		Fields: []registry.FieldMeta{
			{Name: "id", Column: "id"},
			{Name: "name", Column: "name"},
		},
	}
	row := map[string]any{"id": "1", "name": "Alice"}

	out := BuildResponse(context.Background(), meta, row)
	if len(out) != 2 || out["id"] != "1" || out["name"] != "Alice" {
		t.Errorf("expected both ungated fields to pass through untouched, got %v", out)
	}
}

func TestBuildResponse_PublicScopeOmitsNonPublicKeys(t *testing.T) {
	meta := registry.TableMeta{Fields: []registry.FieldMeta{
		{Name: "id", Column: "id"}, {Name: "name", Column: "name"}, {Name: "cost", Column: "cost"},
	}}
	row := map[string]any{"id": "1", "name": "Chair", "cost": 12}
	ctx := access.WithPublicScope(context.Background(), access.PublicScope{Columns: []string{"id", "name"}})
	out := BuildResponse(ctx, meta, row)
	if _, ok := out["cost"]; ok || out["name"] != "Chair" || out["id"] != "1" {
		t.Errorf("out = %v, want id+name only", out)
	}
}
