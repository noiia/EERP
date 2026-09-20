// Package graphfield owns chart-only calculated fields: a named formula over
// an entity's own numeric fields (and hard-coded numbers) that a user creates
// from the Graph view and that every graph tile type can then plot like a
// real column. Off the generic CRUD surface — the row is role-gated (a field
// is only listed to callers whose roles intersect Roles) and the formula is
// checked on write, neither of which a column-whitelist handler expresses.
// The formula is EVALUATED client-side over the records the tile already
// fetched, so it can only ever see columns the caller's own group gating
// (ADR-013) already let through.
package graphfield

import "core/orm/model"

// GraphField is one calculated field, scoped to a single entity's Graph view.
type GraphField struct {
	model.BaseModel
	Entity string `db:"entity,index"`
	// Key is the identifier tiles reference ("calc_profit"); unique per
	// (tenant, entity) via the hand-written index in modules/graphfield.
	Key   string `db:"field_key"`
	Label string `db:"label"`
	// Formula is infix arithmetic over field keys / other calc keys /
	// number literals: + - * / and parentheses. Opaque beyond the charset check.
	Formula string `db:"formula"`
	// Roles is a comma-joined list of role technical names allowed to see the
	// field. Empty = everyone in the tenant.
	Roles string `db:"roles"`
	// Dated: compute the formula once per dated child row (e.g. each rent
	// receipt of each property) instead of once per listed record.
	Dated bool `db:"dated"`
}
