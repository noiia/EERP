package auth

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UserRepository provides auth-specific user queries.
type UserRepository struct {
	users *orm.Repository[Users]
	db    *orm.DB
}

// NewUserRepository constructs a UserRepository bound to db.
func NewUserRepository(db *orm.DB) *UserRepository {
	return &UserRepository{
		users: orm.MustRepo[Users](db),
		db:    db,
	}
}

// FindByEmail returns the active user with the given email address.
// Returns orm.ErrNotFound (pgx.ErrNoRows) when not found or soft-deleted.
func (r *UserRepository) FindByEmail(ctx context.Context, email string) (Users, error) {
	u, err := r.users.FindOne(ctx, orm.Cond("email = $1", email))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Users{}, fmt.Errorf("user: find by email: %w", orm.ErrNotFound)
		}
		return Users{}, fmt.Errorf("user: find by email: %w", err)
	}
	return u, nil
}

// FindByID returns the active user with the given UUID.
func (r *UserRepository) FindByID(ctx context.Context, id uuid.UUID) (Users, error) {
	u, err := r.users.FindByID(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Users{}, fmt.Errorf("user: find by id: %w", orm.ErrNotFound)
		}
		return Users{}, fmt.Errorf("user: find by id: %w", err)
	}
	return u, nil
}

// SetPreferredLocale updates the user's display-language preference.
// nil clears the preference (the user inherits the tenant default).
func (r *UserRepository) SetPreferredLocale(ctx context.Context, userID uuid.UUID, locale *string) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE users
		SET preferred_locale = $1, updated_at = now()
		WHERE id = $2 AND deleted_at IS NULL
	`, locale, userID)
	if err != nil {
		return fmt.Errorf("user: set preferred locale: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("user: set preferred locale: %w", orm.ErrNotFound)
	}
	return nil
}

// SetActiveCompany updates the user's active-company selection. nil clears
// it (the caller falls back through company.Repository.ResolveActive's
// bootstrap on next touch) — same shape as SetPreferredLocale.
func (r *UserRepository) SetActiveCompany(ctx context.Context, userID uuid.UUID, companyID *uuid.UUID) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE users
		SET active_company_id = $1, updated_at = now()
		WHERE id = $2 AND deleted_at IS NULL
	`, companyID, userID)
	if err != nil {
		return fmt.Errorf("user: set active company: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("user: set active company: %w", orm.ErrNotFound)
	}
	return nil
}

// FindRoleNames returns the role names assigned to the given user.
func (r *UserRepository) FindRoleNames(ctx context.Context, userID uuid.UUID) ([]string, error) {
	rows, err := r.db.Query(ctx, `
		SELECT r.name
		FROM roles r
		JOIN user_roles ur ON ur.role_id = r.id
		WHERE ur.user_id = $1
		  AND r.deleted_at IS NULL
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("user: find role names: %w", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("user: scan role name: %w", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("user: find role names: %w", err)
	}
	return names, nil
}

// FindGroups returns the technical-name closure of every group the user's
// roles resolve to: their directly-assigned roles' own technical_name, plus
// every role transitively "belonged to" via role_belongs (Odoo's
// implied_ids). The recursive CTE uses a plain UNION (not UNION ALL), which
// dedupes visited role ids on every step — a cycle (A belongs_to B
// belongs_to A) simply stops re-adding an id already in the closure, so no
// application-level visited-set/cycle-detection code is needed.
func (r *UserRepository) FindGroups(ctx context.Context, userID uuid.UUID) ([]string, error) {
	rows, err := r.db.Query(ctx, `
		WITH RECURSIVE closure(id) AS (
			SELECT ur.role_id FROM user_roles ur WHERE ur.user_id = $1
			UNION
			SELECT rb.belongs_to_role_id
			FROM role_belongs rb
			JOIN closure c ON c.id = rb.role_id
		)
		SELECT DISTINCT r.technical_name
		FROM roles r
		JOIN closure c ON c.id = r.id
		WHERE r.deleted_at IS NULL AND r.technical_name IS NOT NULL
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("user: find groups: %w", err)
	}
	defer rows.Close()

	var groups []string
	for rows.Next() {
		var group string
		if err := rows.Scan(&group); err != nil {
			return nil, fmt.Errorf("user: scan group: %w", err)
		}
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("user: find groups: %w", err)
	}
	return groups, nil
}
