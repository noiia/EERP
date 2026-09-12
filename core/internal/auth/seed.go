package auth

import (
	"context"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// Development seed credentials. DEV ONLY — gated behind the seed_dev_admin config flag.
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
	devPermID   = uuid.MustParse("000000c0-0000-0000-0000-000000000001")
)

// SeedDevAdmin creates a development administrator (admin@eerp.local / "admin") with an
// "admin" role granting the "*:*:*" wildcard permission, so it can log in AND pass the
// permission middleware on every data route. Idempotent and DEV ONLY — never enable
// seed_dev_admin in production.
func SeedDevAdmin(ctx context.Context, db *orm.DB) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(DevAdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("seed dev admin: hash password: %w", err)
	}

	statements := []struct {
		sql  string
		args []any
	}{
		{
			`INSERT INTO users (id, tenant_id, email, password_hash, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{devUserID, DevTenantID, DevAdminEmail, string(hash)},
		},
		{
			`INSERT INTO roles (id, tenant_id, name, description, created_at, updated_at)
			 VALUES ($1, $2, 'admin', 'Development administrator', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{devRoleID, DevTenantID},
		},
		{
			`INSERT INTO permissions (id, code, description, module, created_at, updated_at)
			 VALUES ($1, '*:*:*', 'Full access (dev admin)', '*', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{devPermID},
		},
		{
			`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[]any{devUserID, devRoleID},
		},
		{
			`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[]any{devRoleID, devPermID},
		},
	}

	for _, s := range statements {
		if _, err := db.Exec(ctx, s.sql, s.args...); err != nil {
			return fmt.Errorf("seed dev admin: %w", err)
		}
	}
	return SeedDefaultRoles(ctx, db, DevTenantID)
}

// accountRoleTypeNames are the four rights account_role_types seeds once per
// tenant. "Create"/"edit" stay merged into the single existing "write"
// permission action (core/internal/middleware's own DSL) — see
// RoleViewPermission's own doc comment.
var accountRoleTypeNames = []string{"deny", "read", "write", "delete"}

// seedUUID derives a stable, reproducible v5 UUID from a tenant + a fixed
// label, so re-running SeedDefaultRoles for the same tenant is idempotent via
// plain `ON CONFLICT (id) DO NOTHING` — the same idempotency shape
// SeedDevAdmin's own fixed IDs already rely on, just parameterized per tenant
// instead of hardcoded, since this runs for any tenant, not only the dev one.
func seedUUID(tenantID uuid.UUID, label string) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(tenantID.String()+":"+label))
}

type seedStatement struct {
	sql  string
	args []any
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
// per-view "rights" table (RoleViewPermission/RoleViewPermissionRight) is
// left EMPTY — that table is a data model + UI for an admin to
// document/refine access per view, not yet consulted by any enforcement
// path (see RoleViewPermission's own doc comment).
//
// Not currently called from any production tenant-provisioning flow — none
// exists yet in this codebase (tenants aren't self-serve today). SeedDevAdmin
// calls this for the dev tenant so the feature is exercised end-to-end in
// dev; a future real "create tenant" flow should call this too.
func SeedDefaultRoles(ctx context.Context, db *orm.DB, tenantID uuid.UUID) error {
	adminRoleID := seedUUID(tenantID, "role:admin")
	viewerRoleID := seedUUID(tenantID, "role:viewer")
	denyRoleID := seedUUID(tenantID, "role:deny")
	adminPermID := seedUUID(tenantID, "permission:*:*:*")
	viewerPermID := seedUUID(tenantID, "permission:*:*:read")

	statements := []seedStatement{
		{
			`INSERT INTO roles (id, tenant_id, name, description, technical_name, created_at, updated_at)
			 VALUES ($1, $2, 'Admin', 'Full access to every model.', 'admin', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{adminRoleID, tenantID},
		},
		{
			`INSERT INTO roles (id, tenant_id, name, description, technical_name, created_at, updated_at)
			 VALUES ($1, $2, 'Viewer', 'Read-only access to every model.', 'viewer', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{viewerRoleID, tenantID},
		},
		{
			`INSERT INTO roles (id, tenant_id, name, description, technical_name, created_at, updated_at)
			 VALUES ($1, $2, 'Deny', 'No access to anything.', 'deny', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{denyRoleID, tenantID},
		},
		{
			`INSERT INTO permissions (id, code, description, module, created_at, updated_at)
			 VALUES ($1, '*:*:*', 'Full access (default Admin role)', '*', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{adminPermID},
		},
		{
			`INSERT INTO permissions (id, code, description, module, created_at, updated_at)
			 VALUES ($1, '*:*:read', 'Read-only access (default Viewer role)', '*', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{viewerPermID},
		},
		{
			`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[]any{adminRoleID, adminPermID},
		},
		{
			`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[]any{viewerRoleID, viewerPermID},
		},
	}
	for _, name := range accountRoleTypeNames {
		statements = append(statements, seedStatement{
			`INSERT INTO account_role_types (id, tenant_id, name, created_at, updated_at)
			 VALUES ($1, $2, $3, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{seedUUID(tenantID, "role_type:"+name), tenantID, name},
		})
	}

	for _, s := range statements {
		if _, err := db.Exec(ctx, s.sql, s.args...); err != nil {
			return fmt.Errorf("seed default roles: %w", err)
		}
	}
	return nil
}
