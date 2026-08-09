package auth

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// User represents an EERP user account.
// password_hash is excluded from the API in code via WithExcludeFields (fail-closed);
// it is intentionally not relying on api.yaml for that guarantee.
type Users struct {
	model.BaseModel
	TenantID     uuid.UUID `db:"tenant_id"`
	Email        string    `db:"email"`
	PasswordHash string    `db:"password_hash"`
	// PreferredLocale is the user's display-language choice. nil inherits the
	// tenant default (app_settings "i18n.default_locale"); the reserved value
	// "source" forces the untranslated source language.
	PreferredLocale *string `db:"preferred_locale"`
	// ActiveCompanyID is the caller's current company selection — nil until
	// company.Repository.ResolveActive lazily bootstraps it on first touch of
	// any company-scoped setting, same posture as PreferredLocale.
	ActiveCompanyID *uuid.UUID `db:"active_company_id"`
}

// Role is a named set of permissions scoped to a tenant.
type Roles struct {
	model.BaseModel
	TenantID    uuid.UUID `db:"tenant_id"`
	Name        string    `db:"name"`
	Description string    `db:"description"`
}

// Permission represents a single capability using the "module:resource:action" DSL.
type Permissions struct {
	model.BaseModel
	Code        string `db:"code"`
	Description string `db:"description"`
	Module      string `db:"module"`
}

// UserRole is the join between users and roles (no BaseModel — composite PK).
type UserRoles struct {
	UserID uuid.UUID `db:"user_id,pk"`
	RoleID uuid.UUID `db:"role_id,pk"`
}

// RolePermission is the join between roles and permissions (no BaseModel — composite PK).
type RolePermissions struct {
	RoleID       uuid.UUID `db:"role_id,pk"`
	PermissionID uuid.UUID `db:"permission_id,pk"`
}

// RefreshToken stores a bcrypt hash of an issued refresh token.
// The raw token is never persisted — only its hash.
type RefreshTokens struct {
	model.BaseModel
	UserID    uuid.UUID `db:"user_id"`
	TokenHash string    `db:"token_hash"`
	ExpiresAt time.Time `db:"expires_at"`
	Revoked   bool      `db:"revoked"`
}
