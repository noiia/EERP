package internal

import (
	"core/orm/model"
)

type Contact struct {
	model.BaseModel
	Name    string `db:"name"`
	Email   string `db:"email"`
	Company string `db:"company"`
	Status  string `db:"status"` // "lead", "prospect", "customer", "churned"
}
