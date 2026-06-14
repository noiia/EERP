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
