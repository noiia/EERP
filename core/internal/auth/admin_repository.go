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

// UserProfile carries every field the admin surface (AdminHandler) lets a
// caller write, on both Create and Update. Password is a WRITE-ONLY
// convenience: it never appears in any response (adminUserResponse has no
// such field), and it's optional — blank on Create keeps the existing
// LOCKED-account behavior (see CreateUser's own doc comment below); blank on
// Update leaves the existing credential untouched rather than re-locking the
// account.
type UserProfile struct {
	Email             string
	Password          string
	Username          *string
	Name              string
	Surname           string
	DisplayName       string
	JobTitle          string
	Phone             string
	AddressNumber     *int
	AddressComplement string
	AddressStreet     string
	AddressZipCode    string
	AddressCity       string
	AddressState      string
	AddressCountry    string
}

// applyProfile copies every UserProfile field onto u EXCEPT Password, which
// each caller (CreateUser/UpdateProfile) handles on its own since "blank"
// means something different in each direction (lock vs. leave untouched).
func applyProfile(u *Users, profile UserProfile) {
	u.Email = profile.Email
	u.Username = profile.Username
	u.Name = profile.Name
	u.Surname = profile.Surname
	u.DisplayName = profile.DisplayName
	u.JobTitle = profile.JobTitle
	u.Phone = profile.Phone
	u.AddressNumber = profile.AddressNumber
	u.AddressComplement = profile.AddressComplement
	u.AddressStreet = profile.AddressStreet
	u.AddressZipCode = profile.AddressZipCode
	u.AddressCity = profile.AddressCity
	u.AddressState = profile.AddressState
	u.AddressCountry = profile.AddressCountry
}

// UpdateProfile sets every UserProfile field. The record is re-read
// tenant-scoped first, so only whitelisted fields change and the tenant
// check cannot be bypassed by the id. A blank profile.Password leaves the
// existing credential untouched — Update is not how an account gets LOCKED
// back out.
func (r *UserRepository) UpdateProfile(ctx context.Context, tenantID, id uuid.UUID, profile UserProfile) (Users, error) {
	u, err := r.FindInTenant(ctx, tenantID, id)
	if err != nil {
		return Users{}, err
	}
	applyProfile(&u, profile)
	if profile.Password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(profile.Password), bcrypt.DefaultCost)
		if err != nil {
			return Users{}, fmt.Errorf("user: update profile: hash password: %w", err)
		}
		u.PasswordHash = string(hash)
	}
	updated, err := r.users.Update(ctx, u, id)
	if err != nil {
		return Users{}, fmt.Errorf("user: update profile: %w", err)
	}
	return updated, nil
}

// CreateUser creates a user in the tenant. A blank profile.Password creates a
// LOCKED credential: the password hash is derived from random bytes that are
// immediately discarded, so no password can ever match it — the account
// exists (assignable, listable, editable) but cannot log in until a real
// password is set (here, later via UpdateProfile, or a dedicated invitation
// flow). A non-blank profile.Password is hashed and used directly, so the
// account is usable immediately.
func (r *UserRepository) CreateUser(ctx context.Context, tenantID uuid.UUID, profile UserProfile) (Users, error) {
	hash, err := hashOrLock(profile.Password)
	if err != nil {
		return Users{}, fmt.Errorf("user: create: %w", err)
	}

	u := Users{TenantID: tenantID, PasswordHash: hash}
	applyProfile(&u, profile)

	created, err := r.users.Create(ctx, u)
	if err != nil {
		return Users{}, fmt.Errorf("user: create: %w", err)
	}
	return created, nil
}

// hashOrLock hashes a real password, or — when password is blank — derives a
// LOCKED hash from random, immediately-discarded bytes (see CreateUser's own
// doc comment).
func hashOrLock(password string) (string, error) {
	if password == "" {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return "", fmt.Errorf("generate locked credential: %w", err)
		}
		password = string(raw)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash credential: %w", err)
	}
	return string(hash), nil
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
