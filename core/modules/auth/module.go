// Package auth registers the authentication entities with the ORM registry.
// Import this package via core/modules/all to activate it.
package auth

import (
	"context"
	"fmt"

	"core/internal/auth"
	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&authModule{})
}

type authModule struct{}

func (m *authModule) Name() string { return "auth" }

func (m *authModule) Register() error {
	// The auth tables are registered with the ORM (so their schemas migrate and the
	// typed repos work) but kept OFF the generic HTTP CRUD surface via WithExcluded.
	// Auto-generated CRUD on these is a privilege-escalation and cross-tenant
	// integrity risk (mutating the global permission catalog, creating password-less
	// users, deleting roles). Account/role/permission management must go through
	// dedicated, audited endpoints — never the generic CRUD. Enforced in code so the
	// guarantee is fail-closed, not dependent on an external config file.
	if err := orm.Register[auth.Users](
		orm.WithTableName("users"),
		orm.WithExcludeFields("password_hash"),
		orm.WithExcluded(),
	); err != nil {
		return err
	}
	if err := orm.Register[auth.Roles](orm.WithExcluded()); err != nil {
		return err
	}
	if err := orm.Register[auth.Permissions](orm.WithExcluded()); err != nil {
		return err
	}
	if err := orm.Register[auth.RefreshTokens](orm.WithExcluded()); err != nil {
		return err
	}
	// RoleBelongs is deliberately NOT WithExcluded: it rides the generic CRUD
	// surface (like any module's own many2many junction) so the frontend's
	// existing RelationTagsWidget/RelationOps drive the Roles form's "Belongs"
	// tab with no bespoke endpoint or widget code. The coarse
	// role_belongs:role_belongs:* permission this derives is granted to the
	// default admin role in seed.go alongside roles:roles:*.
	if err := orm.Register[auth.RoleBelongs](); err != nil {
		return err
	}
	// The role "rights" table (Role form's own first notebook page) and its
	// backing catalog/junction — all three ride the generic CRUD surface,
	// same posture as RoleBelongs above, so the Role form's embedded
	// RelationListWidget table and many2many tags widget need no bespoke
	// endpoint. See RoleViewPermission's own doc comment: data model + UI
	// only, not yet consulted by any permission check.
	if err := orm.Register[auth.AccountRoleTypes](); err != nil {
		return err
	}
	if err := orm.Register[auth.RoleViewPermission](); err != nil {
		return err
	}
	if err := orm.Register[auth.RoleViewPermissionRight](); err != nil {
		return err
	}
	// UserRoles is deliberately NOT WithExcluded — mirrors RoleBelongs above,
	// so the User form's `role` many2many tags field needs no bespoke
	// endpoint. FindRoleNames/FindGroups (user_repository.go) filter
	// deleted_at IS NULL themselves since this junction is now soft-deletable.
	if err := orm.Register[auth.UserRoles](); err != nil {
		return err
	}
	return nil
}

// Migrate creates the role_permissions join table (composite PK, no
// BaseModel — the auto-migration system cannot derive it from a Go struct)
// and the unique constraints struct tags can't express.
func (m *authModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS role_permissions (
			role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
			permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
			PRIMARY KEY (role_id, permission_id)
		)
	`); err != nil {
		return fmt.Errorf("auth: create role_permissions: %w", err)
	}

	// Struct-tag auto-migration only supports plain (non-unique) indexes, so a
	// per-tenant uniqueness guarantee on technical_name has to be hand-written
	// here. Partial on technical_name IS NOT NULL (nullable column, see
	// Roles.TechnicalName) and deleted_at IS NULL so a soft-deleted role
	// doesn't permanently squat a slug.
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_tenant_technical_name
		ON roles (tenant_id, technical_name)
		WHERE technical_name IS NOT NULL AND deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("auth: create roles technical_name index: %w", err)
	}

	// UserRoles now rides model.BaseModel instead of the raw, composite-PK
	// table it used to be. An installation that already ran the old shape has
	// a real user_roles table on disk — ensureTable's CREATE TABLE IF NOT
	// EXISTS no-ops once a table exists, so the generic auto-migration path
	// never backfills id/created_at/updated_at/deleted_at onto it. Do that by
	// hand, once, detected by the absence of `id` (a fresh install already
	// has it — ensureTable created it from scratch — so this whole block is a
	// no-op there).
	if _, err := db.Exec(ctx, `
		DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_name = 'user_roles' AND column_name = 'id'
			) THEN
				ALTER TABLE user_roles ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
				ALTER TABLE user_roles ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
				ALTER TABLE user_roles ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
				ALTER TABLE user_roles ADD COLUMN deleted_at TIMESTAMPTZ;
				ALTER TABLE user_roles DROP CONSTRAINT user_roles_pkey;
				ALTER TABLE user_roles ADD PRIMARY KEY (id);
			END IF;
		END $$;
	`); err != nil {
		return fmt.Errorf("auth: backfill user_roles base columns: %w", err)
	}

	// A real uniqueness guarantee on the (user_id, role_id) pair needs the
	// same hand-written treatment as technical_name above — struct tags can't
	// express it, and it's what used to be the table's composite PK. Partial
	// on deleted_at IS NULL so unassigning and reassigning the same role
	// doesn't collide with its own soft-deleted row.
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_user_role
		ON user_roles (user_id, role_id)
		WHERE deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("auth: create user_roles unique index: %w", err)
	}

	return nil
}
