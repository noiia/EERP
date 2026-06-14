package auth

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// NewHandlerForTest builds a Handler backed by in-memory stubs for unit testing.
func NewHandlerForTest(user Users, roles []string, findErr error, tokens *TokenService, validateErr error) *Handler {
	return newHandlerWith(
		&stubUserRepo{user: user, roles: roles, findErr: findErr},
		tokens,
		&stubRefreshStore{validateErr: validateErr},
	)
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

type stubUserRepo struct {
	user    Users
	roles   []string
	findErr error
}

func (s *stubUserRepo) FindByEmail(_ context.Context, email string) (Users, error) {
	if s.findErr != nil {
		return Users{}, s.findErr
	}
	if s.user.Email != email {
		return Users{}, ErrUserNotFound
	}
	return s.user, nil
}

func (s *stubUserRepo) FindByID(_ context.Context, id uuid.UUID) (Users, error) {
	if s.findErr != nil {
		return Users{}, s.findErr
	}
	if s.user.ID != id {
		return Users{}, ErrUserNotFound
	}
	return s.user, nil
}

func (s *stubUserRepo) FindRoleNames(_ context.Context, _ uuid.UUID) ([]string, error) {
	return s.roles, nil
}

type stubRefreshStore struct {
	validateErr error
}

func (s *stubRefreshStore) Save(_ context.Context, _ uuid.UUID, _ string, _ time.Time) error {
	return nil
}

func (s *stubRefreshStore) Validate(_ context.Context, _ uuid.UUID, _ string) error {
	return s.validateErr
}

func (s *stubRefreshStore) RevokeAll(_ context.Context, _ uuid.UUID) error {
	return nil
}
