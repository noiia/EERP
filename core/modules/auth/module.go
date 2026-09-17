// Package auth registers the authentication entities with the ORM registry.
// Import this package via core/modules/all to activate it.
package auth

import (
	"context"
	"fmt"

	"core/internal/auth"
	"core/internal/module"
	"core/orm"

	"github.com/google/uuid"
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

	// permissions has no tenant_id (it's a global DSL catalog, not
	// tenant-scoped) — but SeedDefaultRoles/SeedDevAdmin seed it with
	// deterministic ids PER TENANT, so a deployment that has ever seeded more
	// than one tenant (or re-seeded across a reset dev DB) can already have
	// more than one row sharing the same code (e.g. two "*:*:*" rows with
	// different ids). That blocks the unique index below from ever being
	// created, which in turn makes every RightsHandler.reconcile Upsert fail
	// with Postgres 42P10 ("no unique or exclusion constraint matching ON
	// CONFLICT"). Merge those onto one canonical row per code — the oldest,
	// by created_at then id, picked identically by both statements below —
	// BEFORE creating the index, so this self-heals regardless of how the
	// duplicates got there. Cascades on role_permissions.permission_id
	// already handle a role that only ever held the surviving row; the
	// UPDATE below repoints a role that held the LOSING row so it doesn't
	// silently lose that grant (e.g. a tenant's Admin role losing "*:*:*").
	if _, err := db.Exec(ctx, `
		UPDATE role_permissions rp
		SET permission_id = w.winner_id
		FROM (
			SELECT p.id AS loser_id, first.id AS winner_id
			FROM permissions p
			JOIN LATERAL (
				SELECT id FROM permissions p2
				WHERE p2.code = p.code AND p2.deleted_at IS NULL
				ORDER BY p2.created_at, p2.id
				LIMIT 1
			) first ON true
			WHERE p.deleted_at IS NULL AND p.id <> first.id
		) AS w
		WHERE rp.permission_id = w.loser_id
		  AND NOT EXISTS (
			SELECT 1 FROM role_permissions existing
			WHERE existing.role_id = rp.role_id AND existing.permission_id = w.winner_id
		  )
	`); err != nil {
		return fmt.Errorf("auth: repoint duplicate permission grants: %w", err)
	}
	if _, err := db.Exec(ctx, `
		DELETE FROM permissions p
		WHERE p.deleted_at IS NULL
		  AND p.id NOT IN (
			SELECT DISTINCT ON (code) id FROM permissions
			WHERE deleted_at IS NULL
			ORDER BY code, created_at, id
		  )
	`); err != nil {
		return fmt.Errorf("auth: dedupe permissions by code: %w", err)
	}

	// Backs handler.go's RightsHandler.reconcile, which UpsertPartials a
	// derived "entity:entity:action" permission by conflict column "code" —
	// a real unique index is required for Repository.Upsert's ON CONFLICT
	// target (struct tags can't express one; see Roles' own technical_name
	// index below for the established shape). Partial on deleted_at IS NULL,
	// same posture as every other soft-deletable natural key in this file —
	// which is exactly why the caller must use UpsertPartial, not Upsert:
	// Postgres can't infer a partial index as an ON CONFLICT arbiter unless
	// the INSERT repeats its predicate (core/orm/repo's UpsertPartial doc
	// comment has the full explanation).
	if _, err := db.Exec(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_code
		ON permissions (code)
		WHERE deleted_at IS NULL
	`); err != nil {
		return fmt.Errorf("auth: create permissions code index: %w", err)
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

	// UserRoles.TenantID used to be a *uuid.UUID (nullable) specifically so
	// this table's pre-BaseModel rows could keep existing without a NOT NULL
	// failure — see that field's old doc comment (removed now that it's
	// gone). Now that it's the promoted, non-pointer model.BaseModel field,
	// any row still carrying a NULL tenant_id (only possible on an
	// installation old enough to predate that column entirely) needs
	// backfilling from its own user before the column can be tightened to
	// NOT NULL — same two-step "backfill, then constrain" shape
	// propertymanagement/module.go's Migrate already uses for its own
	// pointer-to-non-pointer field changes.
	if _, err := db.Exec(ctx, `
		UPDATE user_roles ur SET tenant_id = u.tenant_id
		FROM users u WHERE ur.user_id = u.id AND ur.tenant_id IS NULL
	`); err != nil {
		return fmt.Errorf("auth: backfill user_roles tenant_id: %w", err)
	}
	if _, err := db.Exec(ctx, `
		ALTER TABLE user_roles ALTER COLUMN tenant_id SET NOT NULL
	`); err != nil {
		return fmt.Errorf("auth: set user_roles tenant_id not null: %w", err)
	}

	// account_role_types (the Rights UI's deny/read/write/delete catalog) is
	// only ever seeded by SeedDefaultRoles, which "is not currently called
	// from any production tenant-provisioning flow — none exists yet in this
	// codebase" (its own doc comment) — so a real tenant can reach the Rights
	// UI with this catalog completely empty: nothing to tag a view with.
	// Self-heal every tenant already on record (a tenant is defined by
	// having at least one user) on every boot — cheap and idempotent
	// (EnsureAccountRoleTypes is a no-op once the four rows exist).
	tenantRows, err := db.Query(ctx, `SELECT DISTINCT tenant_id FROM users WHERE deleted_at IS NULL`)
	if err != nil {
		return fmt.Errorf("auth: list known tenants: %w", err)
	}
	var tenantIDs []uuid.UUID
	for tenantRows.Next() {
		var id uuid.UUID
		if err := tenantRows.Scan(&id); err != nil {
			tenantRows.Close()
			return fmt.Errorf("auth: list known tenants: scan: %w", err)
		}
		tenantIDs = append(tenantIDs, id)
	}
	tenantRows.Close()
	if err := tenantRows.Err(); err != nil {
		return fmt.Errorf("auth: list known tenants: %w", err)
	}
	for _, tenantID := range tenantIDs {
		if err := auth.EnsureAccountRoleTypes(ctx, db, tenantID); err != nil {
			return fmt.Errorf("auth: ensure account role types: %w", err)
		}
	}

	// Self-heals any role_view_permission row left over from before
	// RightsHandler existed (handler.go) — those never triggered a
	// role_permissions sync at write time, so without this a role's Rights
	// table could show everything ticked while still granting nothing.
	// Cheap and idempotent (reconcile just re-derives the same target state
	// every time), so it's fine to run on every boot rather than gating it
	// behind a one-shot migration flag.
	rightsHandler := NewRightsHandler(db, auth.NewPermissionRepository(db))
	if err := rightsHandler.BackfillAll(ctx); err != nil {
		return fmt.Errorf("auth: backfill role view permissions: %w", err)
	}

	return nil
}
