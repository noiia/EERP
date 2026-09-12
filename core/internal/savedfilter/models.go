// Package savedfilter owns named, reusable search-bar filter combinations
// (docs/adr/ADR-014-search-filter-bar.md) — a user builds a set of AND'd
// filters (and optionally a group-by) in the search bar and saves it under a
// name, either private (only they see it) or shared (the whole tenant does).
// This can't live on the generic CRUD surface: "private OR shared" is an
// OR-composed WHERE the generic repository's AND-only .Where() chain can't
// express, and rename/delete need an owner check a bare column-whitelist
// handler doesn't do. The dedicated, tenant-pinned handler here is the only
// HTTP path to it — the same posture internal/notebook and internal/pictures
// already take for record- and anchor-scoped content off the generic surface.
package savedfilter

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// SavedFilter is one named filter combination a user built in a search bar
// and chose to keep. Entity names which search bar it targets (the route
// prefix a ViewDescriptor's `entity` maps to) — a filter is only ever
// offered inside that one entity's search bar.
//
// Config is opaque JSON at this layer (same posture app_settings' Kanban/
// Graph config takes): {"filters":[{field,op,value|values}],"groupBy"?}. The
// backend never inspects field names inside it — the frontend re-validates
// them (existence, group-gating) against the live descriptor when a saved
// filter is applied, and the generic list endpoint's own filter/search/in/
// range parsing + group-gating check (ADR-014) is the actual enforcement
// point once the filter is actually run as a query.
type SavedFilter struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	UserID   uuid.UUID `db:"user_id,index"` // creator; always set, even when Shared
	Entity   string    `db:"entity,index"`
	Name     string    `db:"name"`
	Shared   bool      `db:"shared"` // false = private (owner-only), true = tenant-wide
	Config   string    `db:"config"`
}
