package internal

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// crm is a CRM record — a person or company the business interacts with.
// The table name is derived automatically from the struct name: "crm".
type CRM struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"` // owning tenant; set server-side, enforces row isolation
	Name     string    `db:"name"`
	Email    string    `db:"email"`
	Company  string    `db:"company"`
	Status   string    `db:"status"` // "lead", "prospect", "customer", "churned"
	// Contacts is the optional many2one FK behind the form's contact search
	// widget. Pointer = nullable ON PURPOSE: "no contact" is a legal state and
	// the widget's unlink affordance writes null — a NOT NULL column would 500
	// every create/unlink that leaves the contact unset.
	Contacts *uuid.UUID `db:"contact_id"`
	// Phone/Notes/Satisfaction/Deals back the Phase-1 widget samples on the CRM
	// form (views/crm_views.ts): text/phone (E.164 — a TEXT column on purpose,
	// numeric columns lose the leading + and zeros), text/long, number/percent
	// (stored as a 0..1 ratio, displayed ×100), number/int.
	Phone        string   `db:"phone"`
	Notes        string   `db:"notes"`
	Satisfaction *float64 `db:"satisfaction"`
	Deals        *int64   `db:"deals"`
	// Score is the behavior-layer showcase's stars value: user-editable on the
	// form, re-suggested whenever Status changes (on_change
	// 'crm.scoreFromStatus' — see views/crm_views.ts), committed like any other
	// column. The ,index tag materializes idx_crm_score at migration
	// (CREATE INDEX IF NOT EXISTS — the struct-tag index DDL). Pointer =
	// nullable, so API creates that skip the form remain valid without a score.
	Score *float64 `db:"score,index"`
	// Picture and Signature are the flag columns behind the boolean/picture and
	// boolean/signature widgets on the CRM form: true ⇔ a picture row exists on
	// the (crm, record, <field>) anchor; the picture service owns the bytes.
	// Pointers = nullable for the same reason as Score. Signature also backs a
	// notebook page coded directly in views/crm_views.ts (docs/roadmaps/
	// responsive-displays.md, Phase 4) — its own tab instead of the two-column
	// body; no schema change needed for that, since the column already exists.
	Picture   *bool `db:"picture"`
	Signature *bool `db:"signature"`
}
