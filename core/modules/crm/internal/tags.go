package internal

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// Tag is a label CRM records are tagged with. Linked many2many through the
// crm_tag junction — the frontend's relation/tags widget searches this table
// for candidates and shows Name on each tag chip.
type Tag struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name"`
}

// CrmTag is one crm<->tag link. It lives ON the generic CRUD surface on
// purpose: the tags widget reads the links (filter[crm_id]=...) and writes
// them (POST/DELETE one junction row per link/unlink) through the generic
// routes — no dedicated handler needed. Column names follow the junction
// convention the widget derives: <own entity>_id / <related entity>_id.
type CrmTag struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	CrmID    uuid.UUID `db:"crm_id,index"`
	TagID    uuid.UUID `db:"tag_id"`
}
