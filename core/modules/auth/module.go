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
	if err := orm.Register[auth.Users](
		orm.WithTableName("users"),
		orm.WithExcludeFields("password_hash"),
	); err != nil {
		return err
	}
	if err := orm.Register[auth.Roles](); err != nil {
		return err
	}
	if err := orm.Register[auth.Permissions](); err != nil {
		return err
	}
	// Registered for the ORM (typed repo + migrations) but never exposed over HTTP:
	// refresh-token hashes must not be listable/mutable via the generic CRUD API.
	// Enforced in code (fail-closed), not via api.yaml.
	if err := orm.Register[auth.RefreshTokens](orm.WithExcluded()); err != nil {
		return err
	}
	return nil
}

// Migrate creates the join tables (composite PK, no BaseModel) that the
// auto-migration system cannot derive from Go structs.
func (m *authModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS user_roles (
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
			PRIMARY KEY (user_id, role_id)
		)
	`); err != nil {
		return fmt.Errorf("auth: create user_roles: %w", err)
	}

	if _, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS role_permissions (
			role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
			permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
			PRIMARY KEY (role_id, permission_id)
		)
	`); err != nil {
		return fmt.Errorf("auth: create role_permissions: %w", err)
	}

	return nil
}
