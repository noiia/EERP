package internal

import (
	"core/orm/model"

	"github.com/google/uuid"
)

type Contact struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name"`
	Email    string    `db:"email"`
	Company  string    `db:"company"`
	Status   string    `db:"status"` // "lead", "prospect", "customer", "churned"
}
