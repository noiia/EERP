package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"sort"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

// ErrDuplicateTechnicalName is returned by CreateRole/UpdateRole when the
// technical_name is already used by another role in the tenant — the first
// unique constraint in the codebase (idx_roles_tenant_technical_name, see
// core/modules/auth/module.go's Migrate), so the Postgres 23505 violation is
// mapped here rather than surfacing as a raw 500.
var ErrDuplicateTechnicalName = errors.New("role: technical_name already used in this tenant")

const pgUniqueViolation = "23505"

func mapRoleWriteErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
		return ErrDuplicateTechnicalName
	}
	return err
}

// Tenant-scoped admin queries backing the users/roles management endpoints
// (AdminHandler → Settings → Users in the frontend). The auth tables are off the
// generic CRUD surface, so these are the only write paths — every query pins
// tenant_id from the caller's token, making cross-tenant reads and writes
// impossible by construction.

// ListByTenant returns every active user of the tenant, ordered by email.
func (r *UserRepository) ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]Users, error) {
	users, err := r.users.FindAll(ctx, orm.Cond("tenant_id = $1", tenantID))
	if err != nil {
		return nil, fmt.Errorf("user: list by tenant: %w", err)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Email < users[j].Email })
	return users, nil
}

// FindInTenant returns the active user only when it belongs to the tenant —
// a wrong tenant reads as orm.ErrNotFound, indistinguishable from a missing id.
func (r *UserRepository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Users, error) {
	u, err := r.users.FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2", id, tenantID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Users{}, fmt.Errorf("user: find in tenant: %w", orm.ErrNotFound)
		}
		return Users{}, fmt.Errorf("user: find in tenant: %w", err)
	}
	return u, nil
}

// UpdateEmail sets the user's email. The record is re-read tenant-scoped first, so
// only whitelisted fields change and the tenant check cannot be bypassed by the id.
func (r *UserRepository) UpdateEmail(ctx context.Context, tenantID, id uuid.UUID, email string) (Users, error) {
	u, err := r.FindInTenant(ctx, tenantID, id)
	if err != nil {
		return Users{}, err
	}
	u.Email = email
	updated, err := r.users.Update(ctx, u, id)
	if err != nil {
		return Users{}, fmt.Errorf("user: update email: %w", err)
	}
	return updated, nil
}

// CreateUser creates a user in the tenant with a LOCKED credential: the password
// hash is derived from random bytes that are immediately discarded, so no password
// can ever match it. The account exists (assignable, listable, editable) but cannot
// log in until a dedicated password/invitation flow sets a real credential — that
// flow is deliberately separate from this admin surface.
func (r *UserRepository) CreateUser(ctx context.Context, tenantID uuid.UUID, email string) (Users, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return Users{}, fmt.Errorf("user: create: generate locked credential: %w", err)
	}
	hash, err := bcrypt.GenerateFromPassword(raw, bcrypt.DefaultCost)
	if err != nil {
		return Users{}, fmt.Errorf("user: create: hash locked credential: %w", err)
	}

	created, err := r.users.Create(ctx, Users{
		TenantID:     tenantID,
		Email:        email,
		PasswordHash: string(hash),
	})
	if err != nil {
		return Users{}, fmt.Errorf("user: create: %w", err)
	}
	return created, nil
}

// RoleRepository provides the tenant-scoped role queries the admin endpoints need.
type RoleRepository struct {
	roles *orm.Repository[Roles]
}

// NewRoleRepository constructs a RoleRepository bound to db.
func NewRoleRepository(db *orm.DB) *RoleRepository {
	return &RoleRepository{roles: orm.MustRepo[Roles](db)}
}

// ListByTenant returns every active role of the tenant, ordered by name.
func (r *RoleRepository) ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]Roles, error) {
	roles, err := r.roles.FindAll(ctx, orm.Cond("tenant_id = $1", tenantID))
	if err != nil {
		return nil, fmt.Errorf("role: list by tenant: %w", err)
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Name < roles[j].Name })
	return roles, nil
}

// FindInTenant returns the active role only when it belongs to the tenant.
func (r *RoleRepository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Roles, error) {
	role, err := r.roles.FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2", id, tenantID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Roles{}, fmt.Errorf("role: find in tenant: %w", orm.ErrNotFound)
		}
		return Roles{}, fmt.Errorf("role: find in tenant: %w", err)
	}
	return role, nil
}

// CreateRole creates a role in the tenant. It starts with no permission grants —
// grants keep their own flows. technicalName is nil when left blank (see
// Roles.TechnicalName on why it's nullable).
func (r *RoleRepository) CreateRole(ctx context.Context, tenantID uuid.UUID, name, description string, technicalName *string) (Roles, error) {
	created, err := r.roles.Create(ctx, Roles{
		TenantID:      tenantID,
		Name:          name,
		Description:   description,
		TechnicalName: technicalName,
	})
	if err != nil {
		return Roles{}, fmt.Errorf("role: create: %w", mapRoleWriteErr(err))
	}
	return created, nil
}

// UpdateRole sets the role's name, description, and technical_name (the
// whitelisted fields).
func (r *RoleRepository) UpdateRole(ctx context.Context, tenantID, id uuid.UUID, name, description string, technicalName *string) (Roles, error) {
	role, err := r.FindInTenant(ctx, tenantID, id)
	if err != nil {
		return Roles{}, err
	}
	role.Name = name
	role.Description = description
	role.TechnicalName = technicalName
	updated, err := r.roles.Update(ctx, role, id)
	if err != nil {
		return Roles{}, fmt.Errorf("role: update: %w", mapRoleWriteErr(err))
	}
	return updated, nil
}
