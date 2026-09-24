package auth

import (
	"context"
	"fmt"

	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// Default admin credentials. Seeded unconditionally on every boot (main.go), in every
// mode — this is a bootstrap credential, not a dev-only convenience, so there's no config
// flag gating it and nothing to misconfigure. It's public (it's right here in source), so
// change the password through the app immediately after first login on any deployment
// reachable outside a trusted network.
const (
	DevAdminEmail    = "admin@eerp.local"
	DevAdminPassword = "admin"
)

// Fixed IDs so re-running the seed is idempotent (ON CONFLICT on the primary key).
var (
	// DevTenantID is the tenant every dev seed writes into — exported so another
	// module's own dev-only demo-data seed (e.g. propertymanagement.SeedDemoData) can
	// anchor its rows to the SAME tenant as the dev admin user, without redeclaring it.
	DevTenantID = uuid.MustParse("00000000-0000-0000-0000-000000000001")
	devUserID   = uuid.MustParse("000000a0-0000-0000-0000-000000000001")
	devRoleID   = uuid.MustParse("000000b0-0000-0000-0000-000000000001")
)

// SeedDevAdmin creates the default administrator (admin@eerp.local / "admin") with an
// "admin" role granting the "*:*:*" wildcard permission, so it can log in AND pass the
// permission middleware on every data route. Idempotent (Upsert on a fixed id, ON
// CONFLICT DO NOTHING) — called on every boot regardless of mode, so a password changed
// through the app is never reset back on a later restart.
//
// environment ("development"/"production", types.Config.Environment) decides whether
// the freshly-created row starts with MustChangePassword set — ON CONFLICT DO NOTHING
// means this only ever applies on the very first insert; a later boot (any environment)
// never resets it back on an account whose password has already been changed.
//
// Every insert below goes through Repository.Upsert with an explicit, fixed id and an
// empty setFragment ("" = ON CONFLICT ... DO NOTHING) — the same idempotent,
// deterministic-id shape SeedDefaultRoles uses per-tenant, just with hardcoded ids
// since this always seeds the SAME dev tenant. role_permissions is the one exception:
// its PK is the composite (role_id, permission_id), which orm.Repository[T] — built
// around a single surrogate uuid PK — has no representation for, so it stays raw SQL.
func SeedDevAdmin(ctx context.Context, db *orm.DB, environment string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(DevAdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("seed dev admin: hash password: %w", err)
	}

	users := orm.MustRepo[Users](db)
	roles := orm.MustRepo[Roles](db)
	perms := orm.MustRepo[Permissions](db)
	userRoles := orm.MustRepo[UserRoles](db)

	if _, err := users.Upsert(ctx,
		Users{
			BaseModel:          model.BaseModel{ID: devUserID, TenantID: DevTenantID},
			Email:              DevAdminEmail,
			PasswordHash:       string(hash),
			MustChangePassword: environment == "production",
		},
		[]string{"id"}, ""); err != nil {
		return fmt.Errorf("seed dev admin: users: %w", err)
	}
	if _, err := roles.Upsert(ctx,
		Roles{BaseModel: model.BaseModel{ID: devRoleID, TenantID: DevTenantID}, Name: "admin", Description: "Development administrator"},
		[]string{"id"}, ""); err != nil {
		return fmt.Errorf("seed dev admin: roles: %w", err)
	}
	// The wildcard permission is the SAME logical row SeedDefaultRoles (below)
	// seeds for its own Admin role — same deterministic id (seedUUID), not a
	// separate hardcoded one. Two rows both carrying Code: "*:*:*" would
	// collide on the unique idx_permissions_code index the instant BOTH ran
	// in the same call (which they always do — this function calls
	// SeedDefaultRoles unconditionally below): the first Upsert's own
	// ON CONFLICT (id) DO NOTHING only suppresses a conflict on THAT row's id,
	// not on a differently-id'd row sharing the same code. Reusing the same
	// id makes the second Upsert a clean no-op instead.
	adminPermID := seedUUID(DevTenantID, "permission:*:*:*")
	if _, err := perms.Upsert(ctx,
		Permissions{ID: adminPermID, Code: "*:*:*", Description: "Full access (dev admin)", Module: "*"},
		[]string{"id"}, ""); err != nil {
		return fmt.Errorf("seed dev admin: permissions: %w", err)
	}
	// (user_id, role_id) is the auth module's own hand-written unique index
	// (struct tags can't express one — CLAUDE.md's ORM section) — the id
	// column itself is left to the DB default since nothing else needs to
	// name this row by a fixed id. It's PARTIAL (WHERE deleted_at IS NULL,
	// so unassigning and reassigning the same role doesn't collide with its
	// own soft-deleted row) — UpsertPartial, not Upsert, or Postgres can't
	// infer it as the ON CONFLICT arbiter (core/orm/repo's UpsertPartial doc
	// comment has the full explanation).
	if _, err := userRoles.UpsertPartial(ctx,
		UserRoles{BaseModel: model.BaseModel{TenantID: DevTenantID}, UserID: devUserID, RoleID: devRoleID},
		[]string{"user_id", "role_id"}, "deleted_at IS NULL", ""); err != nil {
		return fmt.Errorf("seed dev admin: user_roles: %w", err)
	}
	if _, err := db.Exec(ctx,
		`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		devRoleID, adminPermID,
	); err != nil {
		return fmt.Errorf("seed dev admin: role_permissions: %w", err)
	}

	return SeedDefaultRoles(ctx, db, DevTenantID)
}

// accountRoleTypeNames are the four rights account_role_types seeds once per
// tenant. "Create"/"edit" stay merged into the single existing "write"
// permission action (core/internal/middleware's own DSL) — see
// RoleViewPermission's own doc comment.
var accountRoleTypeNames = []string{"deny", "read", "write", "delete"}

// adminGrantedRightNames are the rights the default Admin role's per-view
// rows are seeded with. "deny" is deliberately excluded: it exists in the
// account_role_types catalog (accountRoleTypeNames above) so an admin can
// explicitly apply it to lock a specific view, but it must never be a
// DEFAULT grant on a role meant to have full access.
var adminGrantedRightNames = []string{"read", "write", "delete"}

// seedUUID derives a stable, reproducible v5 UUID from a tenant + a fixed
// label, so re-running SeedDefaultRoles for the same tenant is idempotent via
// plain `ON CONFLICT (id) DO NOTHING` (Repository.Upsert with an empty
// setFragment) — the same idempotency shape SeedDevAdmin's own fixed IDs
// already rely on, just parameterized per tenant instead of hardcoded, since
// this runs for any tenant, not only the dev one.
func seedUUID(tenantID uuid.UUID, label string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(tenantID.String()+":"+label))
}

// EnsureAccountRoleTypes idempotently seeds a tenant's account_role_types
// catalog — the four fixed rights (deny/read/write/delete) the Rights UI's
// "rights" tags widget offers (RoleViewPermission's own doc comment). Safe
// to call as often as needed: deterministic per-(tenant, name) ids (seedUUID)
// make every call after the first a no-op.
//
// Split out of SeedDefaultRoles (below) so a caller that only needs THIS
// catalog — not the bundled Admin/Viewer/Deny starter roles SeedDefaultRoles
// also creates — doesn't have to take the rest. modules/auth's RightsHandler
// calls this alone (both at boot, for every tenant already on record, and
// per-request when a role's first view is added) — forcing three new roles
// onto an existing tenant just because its rights catalog was empty would be
// a surprising side effect nobody asked for.
func EnsureAccountRoleTypes(ctx context.Context, db *orm.DB, tenantID uuid.UUID) error {
	roleTypes := orm.MustRepo[AccountRoleTypes](db)
	for _, name := range accountRoleTypeNames {
		rt := AccountRoleTypes{BaseModel: model.BaseModel{ID: seedUUID(tenantID, "role_type:"+name), TenantID: tenantID}, Name: name}
		if _, err := roleTypes.Upsert(ctx, rt, []string{"id"}, ""); err != nil {
			return fmt.Errorf("ensure account role types: %w", err)
		}
	}
	return nil
}

// SeedDefaultRoles idempotently seeds a tenant's account_role_types catalog
// (deny/read/write/delete) and three starter roles:
//   - Admin: the existing "*:*:*" wildcard permission — reads/writes/deletes
//     everything, exactly like the dev seed's own admin role above.
//   - Viewer: "*:*:read" — reads everything, writes/deletes nothing.
//   - Deny: no permission grants at all — the same as any brand-new role,
//     since this system is allow-list only ("deny" IS the absence of a
//     grant, not a separate mechanism).
//
// All three use the SAME role_permissions mechanism PermissionRepository.Has
// already enforces, so they work as real, assignable roles today. Their own
// per-view "rights" table (RoleViewPermission/RoleViewPermissionRight) is a
// data model + UI for an admin to document/refine access per view, not yet
// consulted by any enforcement path (see RoleViewPermission's own doc
// comment) — Viewer/Deny leave it empty, but Admin gets one row per entity
// currently on the generic CRUD surface (orm.ExposedRoutePrefixes, the SAME
// catalog the frontend's `entity` many2one picks from), each carrying
// read/write/delete (never "deny" — see adminGrantedRightNames), so a
// brand-new Admin role's own Views notebook table already lists everything
// instead of starting blank.
//
// Every insert goes through Repository.Upsert(id, "") — deterministic
// per-(tenant, entity[, right]) ids (seedUUID) keep it idempotent, same
// shape SeedDevAdmin uses. role_permissions is the one exception — see
// SeedDevAdmin's own doc comment on why its composite PK stays raw SQL.
//
// Not currently called from any production tenant-provisioning flow — none
// exists yet in this codebase (tenants aren't self-serve today). SeedDevAdmin
// calls this for the dev tenant so the feature is exercised end-to-end in
// dev; a future real "create tenant" flow should call this too.
func SeedDefaultRoles(ctx context.Context, db *orm.DB, tenantID uuid.UUID) error {
	roles := orm.MustRepo[Roles](db)
	perms := orm.MustRepo[Permissions](db)
	viewPerms := orm.MustRepo[RoleViewPermission](db)
	viewPermRights := orm.MustRepo[RoleViewPermissionRight](db)

	adminRoleID := seedUUID(tenantID, "role:admin")
	viewerRoleID := seedUUID(tenantID, "role:viewer")
	denyRoleID := seedUUID(tenantID, "role:deny")
	adminPermID := seedUUID(tenantID, "permission:*:*:*")
	viewerPermID := seedUUID(tenantID, "permission:*:*:read")

	for _, r := range []Roles{
		{BaseModel: model.BaseModel{ID: adminRoleID, TenantID: tenantID}, Name: "Admin", Description: "Full access to every model.", TechnicalName: ptr("admin")},
		{BaseModel: model.BaseModel{ID: viewerRoleID, TenantID: tenantID}, Name: "Viewer", Description: "Read-only access to every model.", TechnicalName: ptr("viewer")},
		{BaseModel: model.BaseModel{ID: denyRoleID, TenantID: tenantID}, Name: "Deny", Description: "No access to anything.", TechnicalName: ptr("deny")},
	} {
		if _, err := roles.Upsert(ctx, r, []string{"id"}, ""); err != nil {
			return fmt.Errorf("seed default roles: roles: %w", err)
		}
	}

	for _, p := range []Permissions{
		{ID: adminPermID, Code: "*:*:*", Description: "Full access (default Admin role)", Module: "*"},
		{ID: viewerPermID, Code: "*:*:read", Description: "Read-only access (default Viewer role)", Module: "*"},
	} {
		if _, err := perms.Upsert(ctx, p, []string{"id"}, ""); err != nil {
			return fmt.Errorf("seed default roles: permissions: %w", err)
		}
	}

	for _, rp := range []struct{ roleID, permID uuid.UUID }{
		{adminRoleID, adminPermID},
		{viewerRoleID, viewerPermID},
	} {
		if _, err := db.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			rp.roleID, rp.permID,
		); err != nil {
			return fmt.Errorf("seed default roles: role_permissions: %w", err)
		}
	}

	if err := EnsureAccountRoleTypes(ctx, db, tenantID); err != nil {
		return fmt.Errorf("seed default roles: %w", err)
	}

	// Give the Admin role every right on every entity currently registered on
	// the generic CRUD surface — same catalog GetViewCatalog/the frontend's
	// `entity` many2one draws from, read in-process (no HTTP round-trip).
	// Deterministic per-(tenant, entity[, right]) ids keep this idempotent.
	for _, entity := range orm.ExposedRoutePrefixes() {
		rvpID := seedUUID(tenantID, "role_view_permission:admin:"+entity)
		rvp := RoleViewPermission{BaseModel: model.BaseModel{ID: rvpID, TenantID: tenantID}, RoleID: adminRoleID, Entity: entity}
		if _, err := viewPerms.Upsert(ctx, rvp, []string{"id"}, ""); err != nil {
			return fmt.Errorf("seed default roles: role_view_permission: %w", err)
		}
		for _, name := range adminGrantedRightNames {
			right := RoleViewPermissionRight{
				BaseModel:            model.BaseModel{ID: seedUUID(tenantID, "role_view_permission_right:admin:"+entity+":"+name), TenantID: tenantID},
				RoleViewPermissionID: rvpID,
				AccountRoleTypeID:    seedUUID(tenantID, "role_type:"+name),
			}
			if _, err := viewPermRights.Upsert(ctx, right, []string{"id"}, ""); err != nil {
				return fmt.Errorf("seed default roles: role_view_permission_right: %w", err)
			}
		}
	}

	return nil
}

// ptr returns a pointer to a copy of v — Roles.TechnicalName is *string, and
// a string literal has no address of its own to take inline.
func ptr[T any](v T) *T { return &v }
