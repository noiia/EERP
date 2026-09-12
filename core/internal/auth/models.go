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
	// Username is an optional handle, separate from Email — nullable (not every
	// tenant/user needs one) and NOT unique-constrained (same posture as
	// Name/Surname below: a display convenience, not an identifier anything
	// else in the system keys off). How it RENDERS (with or without a leading
	// "@") is a workspace-wide display choice, not stored here — see
	// internal/settings.AccountsUsernameAtFormatKey.
	Username *string `db:"username"`
	// Name/Surname/DisplayName/JobTitle/Phone are plain profile fields, all
	// optional (blank string default, same as every other free-text column in
	// this codebase — e.g. Roles.Description) so existing users need no
	// backfill. DisplayName is independent of Name+Surname (not derived) —
	// some tenants prefer a name order or a nickname the two parts alone can't
	// express.
	Name        string `db:"name"`
	Surname     string `db:"surname"`
	DisplayName string `db:"display_name"`
	JobTitle    string `db:"job_title"`
	Phone       string `db:"phone"`
	// Address* — the same 7-sibling-column composite the `type: 'address'`
	// field widget expects (see core-front's AddressWidget and
	// propertymanagement.PropertyManagement's identical block), prefixed
	// "address_" to match the frontend field name 'address'.
	AddressNumber     *int   `db:"address_number"`
	AddressComplement string `db:"address_complement"`
	AddressStreet     string `db:"address_street"`
	AddressZipCode    string `db:"address_zip_code"`
	AddressCity       string `db:"address_city"`
	AddressState      string `db:"address_state"`
	AddressCountry    string `db:"address_country"`
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
	// TechnicalName is a stable slug distinct from Name (which stays mutable
	// and is the identifier the existing permission system/JWT roles claim
	// already relies on — untouched by this field). It's what a field's
	// group-gating list matches against, and what other roles reference via
	// RoleBelongs. Nullable: the ORM's struct-tag migration has no unique
	// modifier, so the unique index (auth module's Migrate) is hand-written
	// SQL scoped to non-null values — existing roles simply don't
	// participate until someone sets one.
	TechnicalName *string `db:"technical_name"`
}

// RoleBelongs is a role's self-referential "implied role" edge (Odoo's
// implied_ids): RoleID belongs to BelongsToRoleID, so a user holding RoleID
// transitively inherits BelongsToRoleID's groups (see
// UserRepository.FindGroups). Unlike UserRoles/RolePermissions this carries
// model.BaseModel (a single uuid PK) rather than a composite PK, because it's
// registered on the generic CRUD surface so the frontend's many2many chips
// widget can address one link by its own row id.
type RoleBelongs struct {
	model.BaseModel
	TenantID        uuid.UUID `db:"tenant_id" json:"tenant_id"`
	RoleID          uuid.UUID `db:"role_id" json:"role_id"`
	BelongsToRoleID uuid.UUID `db:"belongs_to_role_id" json:"belongs_to_role_id"`
}

// AccountRoleTypes is the catalog of fixed rights a role can hold on a
// "view" (entity) — one row per deny/read/write/delete, seeded once
// (core/internal/auth's SeedDefaultRoles) and not meant to be
// created/renamed through the UI, though nothing stops an admin from doing
// so. Rides the generic CRUD surface (like sale.SaleTax) so
// RoleViewPermission's own `rights` many2many tags field below needs no
// bespoke widget.
type AccountRoleTypes struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id" json:"tenant_id"`
	Name     string    `db:"name" json:"name"`
}

// RoleViewPermission is one row of a role's "which views it can see" table —
// the Role form's own first notebook page (roleFormDescriptor). Entity names
// a frontend view by its Go route prefix, the same bare-string convention
// internal/savedfilter.SavedFilter.Entity already uses — still just a plain
// string column, but picked in the frontend from a live catalog of every
// generic-CRUD-registered route prefix (GET /api/v1/views,
// internal/settings.GetViewCatalog) rather than freehand typed, so it always
// reflects this deployment's compiled-in modules. Its own `rights`
// many2many (RoleViewPermissionRight, below) tags which of
// deny/read/write/delete this role holds on it. Rides the generic CRUD
// surface so the embedded RelationListWidget table needs no bespoke
// endpoint.
//
// DATA MODEL AND UI ONLY as introduced: this table does NOT yet feed
// core/internal/middleware's route-permission checks (the module:resource:
// action DSL / PermissionRepository.Has), which stay the sole enforcement
// path — a role's REAL access is still whatever role_permissions grants it.
// Wiring this table into enforcement is a deliberate, separate follow-up.
type RoleViewPermission struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id" json:"tenant_id"`
	RoleID   uuid.UUID `db:"role_id" json:"role_id"`
	Entity   string    `db:"entity" json:"entity"`
}

// RoleViewPermissionRight is the many2many junction behind
// RoleViewPermission's own `rights` tags field — mirrors sale.SaleLineTax
// exactly, scoped to a role-view row instead of a sale line.
type RoleViewPermissionRight struct {
	model.BaseModel
	TenantID             uuid.UUID `db:"tenant_id" json:"tenant_id"`
	RoleViewPermissionID uuid.UUID `db:"role_view_permission_id" json:"role_view_permission_id"`
	AccountRoleTypeID    uuid.UUID `db:"account_role_type_id" json:"account_role_type_id"`
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
