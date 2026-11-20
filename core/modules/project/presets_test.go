package project

import "testing"

// TestTaskGraphPreset: distinct ids, no two tiles overlapping, every tile
// naming one indicator.
func TestTaskGraphPreset(t *testing.T) {
	seen := map[string]bool{}
	for i, a := range taskGraphPreset {
		if seen[a.ID] {
			t.Errorf("duplicate id %s", a.ID)
		}
		seen[a.ID] = true
		if src, _ := a.Config["source"].(map[string]any); src == nil || src["key"] == "" {
			t.Errorf("%s names no indicator", a.ID)
		}
		for _, b := range taskGraphPreset[i+1:] {
			if a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H {
				t.Errorf("%s overlaps %s", a.ID, b.ID)
			}
		}
	}
}
