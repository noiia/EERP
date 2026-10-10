package internal

import (
	"core/orm"
	"core/orm/model"
)

type Contact struct {
	model.BaseModel
	Name    string `db:"name"`
	Email   string `db:"email"`
	Company string `db:"company"`
	Status  string `db:"status"` // "lead", "prospect", "customer", "churned"
	// Website marks the contact of a website account, created at signup. A
	// pointer: optional on the generic create, NULL on older rows.
	Website *bool `db:"website" json:"website"`
	// GeoLocation: where the contact is (picked on a map or geocoded).
	GeoLocation *orm.GeoPoint `db:"geo_location,index=gist" json:"geo_location"`
}
