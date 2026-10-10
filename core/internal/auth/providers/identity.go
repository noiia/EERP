package providers

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// ExternalIdentity is what an external method proved about a person.
type ExternalIdentity struct {
	Provider      string // "ldap" or "oidc:<provider id>"
	Subject       string // stable id at the provider (LDAP entry DN, OIDC sub)
	Email         string
	EmailVerified bool
	DisplayName   string
	Groups        []string
}

// AuthIdentity links an ERP user to a (provider, subject). Off the generic
// CRUD surface; unique (tenant_id, provider, subject) hand-written in the
// auth module's Migrate.
type AuthIdentity struct {
	model.BaseModel
	UserID   uuid.UUID `db:"user_id"`
	Provider string    `db:"provider"`
	Subject  string    `db:"subject"`
}
