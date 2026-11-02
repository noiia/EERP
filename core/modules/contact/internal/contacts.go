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
	// Surname and Phone: the person's other profile fields (a website
	// signup copies them from the account). Pointers: optional, NULL when empty.
	Surname *string `db:"surname" json:"surname"`
	Phone   *string `db:"phone" json:"phone"`
	// Address*: the same 7-sibling-column composite as users (the
	// `type: 'address'` field widget reads these exact names).
	AddressNumber     *int    `db:"address_number" json:"address_number"`
	AddressComplement *string `db:"address_complement" json:"address_complement"`
	AddressStreet     *string `db:"address_street" json:"address_street"`
	AddressZipCode    *string `db:"address_zip_code" json:"address_zip_code"`
	AddressCity       *string `db:"address_city" json:"address_city"`
	AddressState      *string `db:"address_state" json:"address_state"`
	AddressCountry    *string `db:"address_country" json:"address_country"`
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
