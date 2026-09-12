// Package appstore is the App Store's Go side (docs/roadmaps/app-store.md,
// Phase 3) — a views-only module. It ships no ORM models of its own: the
// module.json data it lists/edits is served by the dedicated
// /api/v1/modules API (internal/module, Phase 1), never the generic CRUD
// surface, so Register() is a deliberate no-op. It still must implement
// GoModule (and call RegisterGoModule) so the backend loader accepts it —
// "type": "go" in module.json already exempts it from WASM loading
// (internal/module/load.go skips mod.Type == "go" there).
package appstore

import "core/internal/module"

func init() {
	module.RegisterGoModule(&appstoreModule{})
}

type appstoreModule struct{}

func (m *appstoreModule) Name() string { return "appstore" }

// Register is a deliberate no-op: appstore has no entity/table of its own.
func (m *appstoreModule) Register() error { return nil }
