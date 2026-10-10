package providers

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"

	"core/orm"

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
// then makes its roles exactly the mapped roles. All in one transaction.
func (p *Provisioner) Provision(ctx context.Context, tenant uuid.UUID, id ExternalIdentity, m Methods) (uuid.UUID, error) {
	roles := mappedRoles(id.Groups, m)
	if len(roles) == 0 || id.Subject == "" {
		return uuid.Nil, ErrRefused
	}
	var userID uuid.UUID
	err := orm.Transact(ctx, p.db, func(tx *orm.Tx) error {
		var err error
		userID, err = resolveUser(ctx, tx, tenant, id)
		if err != nil {
			return err
		}
		return syncRoles(ctx, tx, tenant, userID, roles)
	})
	return userID, err
}

func mappedRoles(groups []string, m Methods) []uuid.UUID {
	set := map[uuid.UUID]bool{}
	for _, g := range groups {
		for _, rm := range m.RoleMapping {
			if strings.EqualFold(strings.TrimSpace(g), strings.TrimSpace(rm.Group)) {
				set[rm.RoleID] = true
			}
		}
	}
	if len(set) == 0 && m.DefaultRoleID != nil {
		set[*m.DefaultRoleID] = true
	}
	out := make([]uuid.UUID, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	return out
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
		return uuid.Nil, fmt.Errorf("provision: create user: %w", err)
	}
	return created, link(ctx, tx, tenant, created, id)
}

func link(ctx context.Context, tx *orm.Tx, tenant, user uuid.UUID, id ExternalIdentity) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_identity (id, tenant_id, user_id, provider, subject) VALUES ($1, $2, $3, $4, $5)`,
		uuid.New(), tenant, user, id.Provider, id.Subject); err != nil {
		return fmt.Errorf("provision: link: %w", err)
	}
	return nil
}

func syncRoles(ctx context.Context, tx *orm.Tx, tenant, user uuid.UUID, roles []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `
		UPDATE user_roles SET deleted_at = now(), updated_at = now()
		WHERE user_id = $1 AND deleted_at IS NULL AND NOT (role_id = ANY($2))`, user, roles); err != nil {
		return fmt.Errorf("provision: drop roles: %w", err)
	}
	for _, r := range roles {
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_roles (id, tenant_id, user_id, role_id) VALUES ($1, $2, $3, $4)
			ON CONFLICT (user_id, role_id) WHERE deleted_at IS NULL DO NOTHING`, uuid.New(), tenant, user, r); err != nil {
			return fmt.Errorf("provision: add role: %w", err)
		}
	}
	return nil
}
