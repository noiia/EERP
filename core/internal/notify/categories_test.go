package notify

import "testing"

func TestRegisterCategory(t *testing.T) {
	// The registry is process-global and this binary's DB tests sync it into
	// every tenant: restore it, so the fake category never reaches a database.
	saved := Categories()
	t.Cleanup(func() {
		catMu.Lock()
		categories = saved
		catMu.Unlock()
	})
	RegisterCategory(Category{Key: "test_cat", Label: "Test category"})
	RegisterCategory(Category{Key: "test_cat", Label: "Renamed"}) // re-registering updates, never duplicates

	tests := []struct {
		name string
		key  string
		want bool
	}{
		{"registered", "test_cat", true},
		{"built-in cron", "cron", true},
		{"built-in seed", "dev_seed", true},
		{"unknown", "nope", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsCategory(tc.key); got != tc.want {
				t.Errorf("IsCategory(%q) = %v, want %v", tc.key, got, tc.want)
			}
		})
	}
	n := 0
	for _, c := range Categories() {
		if c.Key == "test_cat" {
			n++
			if c.Label != "Renamed" {
				t.Errorf("label = %q, want Renamed", c.Label)
			}
		}
	}
	if n != 1 {
		t.Errorf("test_cat listed %d times", n)
	}
}
