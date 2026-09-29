package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"core/internal/mail"
	"core/orm"
	"core/orm/model"

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
	users, err := r.users.FindAll(ctx, orm.Cond("tenant_id = $1 AND kind <> $2", tenantID, KindWebsite))
	if err != nil {
		return nil, fmt.Errorf("user: list by tenant: %w", err)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Email < users[j].Email })
	return users, nil
}

// FindInTenant returns the active user only when it belongs to the tenant —
// a wrong tenant reads as orm.ErrNotFound, indistinguishable from a missing id.
func (r *UserRepository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Users, error) {
	u, err := r.users.FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2 AND kind <> $3", id, tenantID, KindWebsite))
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
		// A real password change clears any pending forced-change requirement —
		// whether it's the caller changing their own (the force-password-change
		// flow) or an admin resetting someone else's, the credential just got
		// rotated either way.
		u.MustChangePassword = false
	}
	updated, err := r.users.Update(ctx, u, id)
	if err != nil {
		return Users{}, fmt.Errorf("user: update profile: %w", mapUserWriteErr(err))
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

	u := Users{BaseModel: model.BaseModel{TenantID: tenantID}, PasswordHash: hash}
	applyProfile(&u, profile)

	created, err := r.users.Create(ctx, u)
	if err != nil {
		return Users{}, fmt.Errorf("user: create: %w", mapUserWriteErr(err))
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
		BaseModel:     model.BaseModel{TenantID: tenantID},
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

// ErrEmailTaken: a live account already uses this address (any case, any kind).
var ErrEmailTaken = errors.New("email already registered")

// CreateWebsiteUser creates a kind=website user holding website_user, in one
// transaction, together with its email-verification token (only the sha256
// is stored, valid 48h) and the "Confirm your email" mail linking to
// siteURL/account/verify. email must already be normalised (trimmed, lower-cased).
func (r *UserRepository) CreateWebsiteUser(ctx context.Context, tenantID uuid.UUID, email, password, name, siteURL string) (Users, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return Users{}, fmt.Errorf("user: create website: %w", err)
	}
	var created Users
	err = orm.Transact(ctx, r.db, func(tx *orm.Tx) error {
		// Explicit pre-check: idx_users_email_live is the race-proof guard, but
		// its creation is non-fatal (modules/auth Migrate), so it may be missing.
		var taken bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL)`, email).Scan(&taken); err != nil {
			return err
		}
		if taken {
			return ErrEmailTaken
		}
		u := Users{BaseModel: model.BaseModel{TenantID: tenantID}, Email: email, PasswordHash: string(hash), Name: name, Kind: KindWebsite}
		if created, err = r.users.WithTx(tx).Create(ctx, u); err != nil {
			return err
		}
		if _, err := orm.MustRepo[UserRoles](r.db).WithTx(tx).Create(ctx,
			UserRoles{BaseModel: model.BaseModel{TenantID: tenantID}, UserID: created.ID, RoleID: WebsiteUserRoleID(tenantID)}); err != nil {
			return err
		}
		tok := make([]byte, 32)
		if _, err := rand.Read(tok); err != nil {
			return err
		}
		raw := hex.EncodeToString(tok)
		sum := sha256.Sum256([]byte(raw))
		if _, err := tx.Exec(ctx, `UPDATE users SET verify_token_hash = $2, verify_expires_at = now() + interval '48 hours' WHERE id = $1`,
			created.ID, hex.EncodeToString(sum[:])); err != nil {
			return err
		}
		return mail.Enqueue(ctx, tx, mail.Message{TenantID: tenantID, To: email, Subject: "Confirm your email",
			Text: "Confirm your email address to see your bookings:\n\n" + strings.TrimRight(siteURL, "/") +
				"/account/verify?token=" + raw + "\n\nThis link expires in 48 hours."})
	})
	if err != nil {
		return Users{}, fmt.Errorf("user: create website: %w", mapUserWriteErr(err))
	}
	return created, nil
}

// mapUserWriteErr maps a violation of idx_users_email_live to ErrEmailTaken;
// any other error (including other unique indexes) passes through.
func mapUserWriteErr(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation && pgErr.ConstraintName == "idx_users_email_live" {
		return ErrEmailTaken
	}
	return err
}

// WebsiteProfile is the part of a website account its owner or a website
// admin may edit. Email is not editable in v1 (it keys booking history, spec 4).
type WebsiteProfile struct {
	Name    string `json:"name"`
	Surname string `json:"surname"`
	Phone   string `json:"phone"`
}

// UpdateWebsiteProfile edits a live website account's profile. UpdateQuery
// does not filter soft-deleted rows, so deleted_at IS NULL is explicit: a
// disabled account reads as not found (re-enable it first).
func (r *UserRepository) UpdateWebsiteProfile(ctx context.Context, tenantID, id uuid.UUID, p WebsiteProfile) error {
	n, err := r.users.UpdateQuery().
		Set("name", p.Name).Set("surname", p.Surname).Set("phone", p.Phone).Set("updated_at", time.Now()).
		Where(orm.Cond("id = $1 AND tenant_id = $2 AND kind = $3 AND deleted_at IS NULL", id, tenantID, KindWebsite)).
		Exec(ctx, r.db)
	if err != nil {
		return fmt.Errorf("user: update website profile: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("user: update website profile: %w", orm.ErrNotFound)
	}
	return nil
}

// ListWebsiteUsers returns tenantID's website accounts, disabled ones
// (soft-deleted) included — raw SQL because the typed repo hides them.
func (r *UserRepository) ListWebsiteUsers(ctx context.Context, tenantID uuid.UUID) ([]Users, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, email, name, surname, phone, created_at, deleted_at, email_verified_at
		FROM users WHERE tenant_id = $1 AND kind = $2 ORDER BY email`, tenantID, KindWebsite)
	if err != nil {
		return nil, fmt.Errorf("user: list website: %w", err)
	}
	defer rows.Close()
	var out []Users
	for rows.Next() {
		var u Users
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Surname, &u.Phone, &u.CreatedAt, &u.DeletedAt, &u.EmailVerifiedAt); err != nil {
			return nil, fmt.Errorf("user: list website: %w", err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetWebsiteUserDisabled soft-deletes (disabled) or restores a website account.
// Login and refresh already refuse a soft-deleted user; the caller also
// revokes its refresh tokens. Restoring an address a new account has taken
// meanwhile returns ErrEmailTaken.
func (r *UserRepository) SetWebsiteUserDisabled(ctx context.Context, tenantID, id uuid.UUID, disabled bool) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE users SET deleted_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND kind = $3`, id, tenantID, KindWebsite, disabled)
	if err != nil {
		return fmt.Errorf("user: disable website: %w", mapUserWriteErr(err))
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("user: disable website: %w", orm.ErrNotFound)
	}
	return nil
}

// FindWebsiteUser returns the live (not disabled) website account of the
// tenant; anything else reads as orm.ErrNotFound.
func (r *UserRepository) FindWebsiteUser(ctx context.Context, tenantID, id uuid.UUID) (Users, error) {
	u, err := r.users.FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2 AND kind = $3", id, tenantID, KindWebsite))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Users{}, fmt.Errorf("user: find website: %w", orm.ErrNotFound)
		}
		return Users{}, fmt.Errorf("user: find website: %w", err)
	}
	return u, nil
}
