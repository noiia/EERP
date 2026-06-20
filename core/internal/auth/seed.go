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
	devTenantID = uuid.MustParse("00000000-0000-0000-0000-000000000001")
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
			[]any{devUserID, devTenantID, DevAdminEmail, string(hash)},
		},
		{
			`INSERT INTO roles (id, tenant_id, name, description, created_at, updated_at)
			 VALUES ($1, $2, 'admin', 'Development administrator', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			[]any{devRoleID, devTenantID},
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
	return nil
}
