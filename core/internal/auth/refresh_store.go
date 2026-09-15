package auth

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"core/orm"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// RefreshStore persists and validates hashed refresh tokens.
type RefreshStore struct {
	tokens *orm.Repository[RefreshTokens]
	db     *orm.DB
}

// NewRefreshStore constructs a RefreshStore bound to db.
func NewRefreshStore(db *orm.DB) *RefreshStore {
	return &RefreshStore{
		tokens: orm.MustRepo[RefreshTokens](db),
		db:     db,
	}
}

// Save hashes rawToken and stores it, revoking all previous tokens for userID first.
// The revoke and insert run in a single transaction so a failure can never leave the
// user with every token revoked and no replacement (which would strand their session).
func (s *RefreshStore) Save(ctx context.Context, userID uuid.UUID, rawToken string, expiresAt time.Time) error {
	digest := sha256.Sum256([]byte(rawToken))
	hash, err := bcrypt.GenerateFromPassword(digest[:], bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("refresh: save: hash token: %w", err)
	}

	return orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		if _, err := s.revokeAll(ctx, tx, userID); err != nil {
			return fmt.Errorf("refresh: save: revoke old tokens: %w", err)
		}
		if _, err := s.tokens.WithTx(tx).Create(ctx, RefreshTokens{
			UserID:    userID,
			TokenHash: string(hash),
			ExpiresAt: expiresAt,
			Revoked:   false,
		}); err != nil {
			return fmt.Errorf("refresh: save: %w", err)
		}
		return nil
	})
}

// Validate returns nil if a valid, non-revoked, non-expired token matching rawToken exists.
// If the token is found but already revoked, it signals a replay attack by returning
// ErrTokenReplayed — callers must RevokeAll and return 401.
func (s *RefreshStore) Validate(ctx context.Context, userID uuid.UUID, rawToken string) error {
	rows, err := s.db.Query(ctx, `
		SELECT id, token_hash, expires_at, revoked
		FROM refresh_tokens
		WHERE user_id = $1
		  AND deleted_at IS NULL
		ORDER BY created_at DESC
		LIMIT 10
	`, userID)
	if err != nil {
		return fmt.Errorf("refresh: validate: query: %w", err)
	}
	defer rows.Close()

	type row struct {
		id        uuid.UUID
		hash      string
		expiresAt time.Time
		revoked   bool
	}
	var candidates []row
	for rows.Next() {
		var r row
		var rawID [16]byte
		if err := rows.Scan(&rawID, &r.hash, &r.expiresAt, &r.revoked); err != nil {
			return fmt.Errorf("refresh: validate: scan: %w", err)
		}
		r.id = uuid.UUID(rawID)
		candidates = append(candidates, r)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("refresh: validate: %w", err)
	}

	for _, c := range candidates {
		tokenDigest := sha256.Sum256([]byte(rawToken))
		if bcrypt.CompareHashAndPassword([]byte(c.hash), tokenDigest[:]) != nil {
			continue // hash doesn't match — try next
		}
		// Hash matched.
		if c.revoked {
			return ErrTokenReplayed
		}
		if time.Now().After(c.expiresAt) {
			return fmt.Errorf("refresh: validate: token expired")
		}
		return nil
	}
	return fmt.Errorf("refresh: validate: token not found")
}

// revokeAll revokes every live refresh token for a user, against ex — the
// original *orm.DB (RevokeAll) or a transaction (Save's own revoke-then-
// insert) — so both express the invariant through the SAME UpdateQuery
// builder call.
func (s *RefreshStore) revokeAll(ctx context.Context, ex orm.Executor, userID uuid.UUID) (int64, error) {
	return s.tokens.UpdateQuery().
		Set("revoked", true).
		Set("updated_at", time.Now()).
		Where(orm.Cond("user_id = $1", userID)).
		Where(orm.Cond("revoked = FALSE")).
		Where(orm.Cond("deleted_at IS NULL")).
		Exec(ctx, ex)
}

// RevokeAll soft-revokes all refresh tokens for userID.
func (s *RefreshStore) RevokeAll(ctx context.Context, userID uuid.UUID) error {
	if _, err := s.revokeAll(ctx, s.db, userID); err != nil {
		return fmt.Errorf("refresh: revoke all: %w", err)
	}
	return nil
}

// ErrTokenReplayed is returned by Validate when a revoked token is presented
// (replay attack detected). Callers must RevokeAll and return 401.
var ErrTokenReplayed = errors.New("refresh: token replayed")
