package graphfield

import (
	"testing"

	"core/internal/auth"
)

func TestVisible(t *testing.T) {
	tests := []struct {
		name  string
		roles string
		id    auth.Identity
		want  bool
	}{
		{"no roles = everyone", "", auth.Identity{}, true},
		{"matching role", "hr", auth.Identity{Roles: []string{"hr"}}, true},
		{"matching inherited group", "hr", auth.Identity{Groups: []string{"hr"}}, true},
		{"no intersection", "hr,admin", auth.Identity{Roles: []string{"sales"}}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := visible(GraphField{Roles: tt.roles}, tt.id); got != tt.want {
				t.Fatalf("visible = %v, want %v", got, tt.want)
			}
		})
	}
}
