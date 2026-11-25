package main

import (
	"context"
	"sort"

	"core/orm"
)

// Step is a data fix a release needs that the boot migration cannot derive.
// Pre steps run on the restored database before the migration, post steps after.
type Step struct {
	Release string // the release that introduced the need; the step runs for targets >= Release
	Pre     bool
	Name    string
	Run     func(ctx context.Context, db *orm.DB) error
}

// steps is empty in v1. The rule for adding one: it must be idempotent and detect
// from the schema whether it applies, since the input's own version may be unknown.
var steps []Step

// stepsFor returns the pre or post steps with Release <= target, in Release order.
func stepsFor(target string, pre bool) []Step {
	var out []Step
	for _, s := range steps {
		if s.Pre != pre {
			continue
		}
		if c, err := compareVersions(s.Release, target); err == nil && c <= 0 {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		c, _ := compareVersions(out[i].Release, out[j].Release)
		return c < 0
	})
	return out
}
