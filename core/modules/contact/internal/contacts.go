package internal

import (
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

type Contact struct {
	model.BaseModel
	Name    string `db:"name"`
	Email   string `db:"email"`
	Company string `db:"company"`
	Status  string `db:"status"` // "lead", "prospect", "customer", "churned"
	// Kind: "company" (a parent) or "contact" (a person, its child). Linked
	// many2many through ContactCompany — a contact belongs to 0..n companies,
	// a company has 0..n contacts. A pointer: optional on the generic create;
	// Migrate backfills NULL rows as "contact".
	Kind *string `db:"kind,index" json:"kind"`
	// Website marks the contact of a website account, created at signup. A
	// pointer: optional on the generic create, NULL on older rows.
	Website *bool `db:"website" json:"website"`
	// GeoLocation: where the contact is (picked on a map or geocoded).
	GeoLocation *orm.GeoPoint `db:"geo_location,index=gist" json:"geo_location"`
}

// ContactCompany links a contact (kind "contact") to a company (kind
// "company"), both rows of contact. It rides the generic CRUD surface — the
// form's tags widgets write it from either side — with a hand-written unique
// (contact, company) index in the module's Migrate.
type ContactCompany struct {
	model.BaseModel
	ContactID uuid.UUID `db:"contact_id,index" json:"contact_id"`
	CompanyID uuid.UUID `db:"company_id,index" json:"company_id"`
}
