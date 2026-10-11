package providers

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"core/orm"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

// ErrRefused: the identity can't be signed in (unlinkable, disabled, no role).
// Callers answer the same generic 401 as a bad password.
var ErrRefused = errors.New("providers: sign-in refused")

type Provisioner struct{ db *orm.DB }

func NewProvisioner(db *orm.DB) *Provisioner { return &Provisioner{db: db} }

// Provision resolves the ERP user for id in tenant — linked identity, else
// (verified email only) the live ERP user with that email, else a new one —
// then syncs the roles id.Provider manages (see syncRoles). All in one
// transaction. id.Provider ("ldap" / "oidc:<id>") selects the method's own
// mappings, default role and allowed_domains.
func (p *Provisioner) Provision(ctx context.Context, tenant uuid.UUID, id ExternalIdentity, m Methods) (uuid.UUID, error) {
	if id.Subject == "" || !m.DomainAllowed(id) {
		return uuid.Nil, ErrRefused
	}
	granted, managed := methodRoles(id.Provider, id.Groups, m)
	var userID uuid.UUID
	err := orm.Transact(ctx, p.db, func(tx *orm.Tx) error {
		var err error
		userID, err = resolveUser(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		return syncRoles(ctx, tx, tenant, userID, granted, managed)
	})
	return userID, err
}

// UnlinkProvider soft-deletes every link of provider ("oidc:<id>") in
// tenant — called when a provider's issuer changes, since the same subject
// at another issuer is another person.
func (p *Provisioner) UnlinkProvider(ctx context.Context, tenant uuid.UUID, provider string) error {
	if _, err := p.db.Exec(ctx, `
		UPDATE auth_identity SET deleted_at = now(), updated_at = now()
		WHERE tenant_id = $1 AND provider = $2 AND deleted_at IS NULL`, tenant, provider); err != nil {
		return fmt.Errorf("provision: unlink %s: %w", provider, err)
	}
	return nil
}

// methodRoles returns the roles a sign-in through method grants (the mapped
// roles of the user's groups, else the method's default role) and the roles
// the method manages (every role its applicable mapping rows or default
// name). Mapping rows apply when unscoped or scoped to method.
func methodRoles(method string, groups []string, m Methods) (granted, managed []uuid.UUID) {
	grant, manage := map[uuid.UUID]bool{}, map[uuid.UUID]bool{}
	for _, rm := range m.RoleMapping {
		if rm.Method != "" && rm.Method != method {
			continue
		}
		manage[rm.RoleID] = true
		for _, g := range groups {
			if strings.EqualFold(strings.TrimSpace(g), strings.TrimSpace(rm.Group)) {
				grant[rm.RoleID] = true
			}
		}
	}
	if def := m.DefaultRole(method); def != nil {
		manage[*def] = true
		if len(grant) == 0 {
			grant[*def] = true
		}
	}
	keys := func(set map[uuid.UUID]bool) []uuid.UUID {
		out := make([]uuid.UUID, 0, len(set)) // never nil: a nil array binds as NULL
		for r := range set {
			out = append(out, r)
		}
		return out
	}
	return keys(grant), keys(manage)
}

func resolveUser(ctx context.Context, tx *orm.Tx, tenant uuid.UUID, id ExternalIdentity) (uuid.UUID, error) {
	// 1. Linked identity.
	var linked uuid.UUID
	var deleted bool
	err := tx.QueryRow(ctx, `
		SELECT u.id, u.deleted_at IS NOT NULL FROM auth_identity a JOIN users u ON u.id = a.user_id
		WHERE a.tenant_id = $1 AND a.provider = $2 AND a.subject = $3 AND a.deleted_at IS NULL`,
		tenant, id.Provider, id.Subject).Scan(&linked, &deleted)
	switch {
	case err == nil:
		if deleted {
			return uuid.Nil, ErrRefused
		}
		return linked, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, fmt.Errorf("provision: find link: %w", err)
	}

	email := strings.ToLower(strings.TrimSpace(id.Email))
	if email == "" {
		return uuid.Nil, ErrRefused
	}
	// 2. Any ERP user (live or disabled) with that email.
	var existing uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT id, deleted_at IS NOT NULL FROM users
		WHERE tenant_id = $1 AND kind = '' AND lower(email) = $2
		ORDER BY deleted_at NULLS FIRST LIMIT 1`, tenant, email).Scan(&existing, &deleted)
	switch {
	case err == nil:
		if deleted || !id.EmailVerified {
			return uuid.Nil, ErrRefused
		}
		var other int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM auth_identity WHERE tenant_id = $1 AND provider = $2 AND user_id = $3 AND deleted_at IS NULL`,
			tenant, id.Provider, existing).Scan(&other); err != nil {
			return uuid.Nil, fmt.Errorf("provision: check link: %w", err)
		}
		if other > 0 {
			return uuid.Nil, ErrRefused // linked to another subject of this provider
		}
		return existing, link(ctx, tx, tenant, existing, id)
	case !errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, fmt.Errorf("provision: find by email: %w", err)
	}

	if !id.EmailVerified {
		return uuid.Nil, ErrRefused
	}
	// 3. Create (locked local password: random, discarded).
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return uuid.Nil, err
	}
	hash, err := bcrypt.GenerateFromPassword(raw, bcrypt.DefaultCost)
	if err != nil {
		return uuid.Nil, err
	}
	created := uuid.New()
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, tenant_id, email, password_hash, display_name, kind)
		VALUES ($1, $2, $3, $4, $5, '')`, created, tenant, email, string(hash), id.DisplayName); err != nil {
		return uuid.Nil, uniqueOr(err, "provision: create user")
	}
	return created, link(ctx, tx, tenant, created, id)
}

// uniqueOr maps a unique violation (concurrent first login, email held by a
// website user or another tenant) to ErrRefused; anything else is wrapped.
func uniqueOr(err error, what string) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return ErrRefused
	}
	return fmt.Errorf("%s: %w", what, err)
}

func link(ctx context.Context, tx *orm.Tx, tenant, user uuid.UUID, id ExternalIdentity) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_identity (id, tenant_id, user_id, provider, subject) VALUES ($1, $2, $3, $4, $5)`,
		uuid.New(), tenant, user, id.Provider, id.Subject); err != nil {
		return uniqueOr(err, "provision: link")
	}
	return nil
}

// syncRoles grants the granted roles and removes the managed roles the user
// no longer qualifies for; roles outside managed (assigned by hand) are never
// touched. The sign-in is refused when the user ends with no live role.
func syncRoles(ctx context.Context, tx *orm.Tx, tenant, user uuid.UUID, granted, managed []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE user_roles SET deleted_at = now(), updated_at = now()
		WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL
		  AND role_id = ANY($3) AND NOT (role_id = ANY($4))`, tenant, user, managed, granted); err != nil {
		return fmt.Errorf("provision: drop roles: %w", err)
	}
	for _, r := range granted {
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_roles (id, tenant_id, user_id, role_id)
			SELECT $1, $2, $3, r.id FROM roles r WHERE r.id = $4 AND r.tenant_id = $2 AND r.deleted_at IS NULL
			ON CONFLICT (user_id, role_id) WHERE deleted_at IS NULL DO NOTHING`, uuid.New(), tenant, user, r); err != nil {
			return fmt.Errorf("provision: add role: %w", err)
		}
	}
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.tenant_id = $1 AND r.deleted_at IS NULL
		WHERE ur.tenant_id = $1 AND ur.user_id = $2 AND ur.deleted_at IS NULL`,
		tenant, user).Scan(&n); err != nil {
		return fmt.Errorf("provision: verify roles: %w", err)
	}
	if n == 0 {
		return ErrRefused
	}
	return nil
}
