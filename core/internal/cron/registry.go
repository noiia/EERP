package cron

import (
	"context"
	"sort"
	"sync"
)

// Action is one background job a Cron row can reference by ActionID — the
// Go-code counterpart to "Cron should be go code added by cron.go files"
// (docs/adr/ADR-016-cron-scheduler.md). A module registers one from its own
// cron.go file's init(), mirroring internal/module's RegisterGoModule shape
// exactly: same file-naming convention, same "call a package-level Register
// at import time" mechanism, just for a runnable action instead of a schema.
type Action struct {
	// ID is what a Cron row's ActionID names. Convention: "<module>.<what>",
	// e.g. "cron.history_retention" — namespaced so two modules can't collide.
	ID    string
	Label string
	// Source is the actual Go source implementing Run, embedded via
	// `//go:embed cron.go` in the registering module's own cron.go file —
	// the form's read-only "Code" notebook page renders this verbatim, so it
	// always shows the real code that runs, never a hand-written description
	// that can drift from it.
	Source string
	// RequiredPermission is the module:resource:action a cron's RunAsUserID
	// must hold for Run to fire (checked via auth.PermissionRepository.Has
	// against the run-as user's own roles — see scheduler.go). Empty means
	// "no permission required," for actions with nothing sensitive to gate.
	RequiredPermission string
	Run                func(ctx context.Context) error
}

var (
	registryMu sync.RWMutex
	registry   = map[string]Action{}
)

// Register enlists an Action. Call from a module's cron.go init(). Last
// registration for a given ID wins — mirrors module.RegisterGoModule's
// "call at init, no dedup enforcement" posture; a colliding ID is a
// developer mistake caught by code review, not something worth panicking
// the whole binary over at import time.
func Register(a Action) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[a.ID] = a
}

// Get resolves a registered Action by id.
func Get(id string) (Action, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	a, ok := registry[id]
	return a, ok
}

// List returns every registered Action, sorted by ID for a stable,
// deterministic order (the cron_actions lookup endpoint's response).
func List() []Action {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]Action, 0, len(registry))
	for _, a := range registry {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// clearForTest empties the registry — test-only (mirrors the frontend
// registries' own clear()).
func clearForTest() {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry = map[string]Action{}
}
