package mcpoauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// Store keeps clients, codes and grants. Codes and refresh tokens are stored as
// sha256 hashes: they are 256-bit random strings, so a fast hash is enough.
type Store struct {
	db      *orm.DB
	clients *orm.Repository[Client]
	codes   *orm.Repository[Code]
	grants  *orm.Repository[Grant]
}

func NewStore(db *orm.DB) *Store {
	return &Store{db: db, clients: orm.MustRepo[Client](db), codes: orm.MustRepo[Code](db), grants: orm.MustRepo[Grant](db)}
}

// errInvalidGrant is every reason a code or refresh token is refused: unknown,
// spent, expired, revoked or issued to another client. The client learns nothing more.
var errInvalidGrant = errors.New("invalid grant")

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b) // crypto/rand.Read never fails (Go ≥ 1.24)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Store) RegisterClient(ctx context.Context, name string, uris []string) (Client, error) {
	raw, err := json.Marshal(uris)
	if err != nil {
		return Client{}, err
	}
	c, err := s.clients.Create(ctx, Client{ClientID: "eerp-" + randomToken(), Name: name, RedirectURIs: string(raw)})
	if err != nil {
		return Client{}, fmt.Errorf("mcpoauth: register client: %w", err)
	}
	return c, nil
}

func (s *Store) FindClient(ctx context.Context, clientID string) (Client, error) {
	rows, err := s.clients.FindAll(ctx, orm.Cond("client_id = $1", clientID), orm.Cond("deleted_at IS NULL"))
	if err != nil {
		return Client{}, fmt.Errorf("mcpoauth: find client: %w", err)
	}
	if len(rows) == 0 {
		return Client{}, errUnknownClient
	}
	return rows[0], nil
}

// CreateCode stores c and returns the raw code to hand to the client.
func (s *Store) CreateCode(ctx context.Context, c Code) (string, error) {
	raw := randomToken()
	c.CodeHash = hashToken(raw)
	if _, err := s.codes.Create(ctx, c); err != nil {
		return "", fmt.Errorf("mcpoauth: create code: %w", err)
	}
	return raw, nil
}

// ExchangeCode spends a code, then creates its grant. Spending commits on its
// own first, so a request check refuses (wrong client, redirect URI or PKCE
// verifier) still burns the code. A code presented a second time revokes the
// grant its first exchange created (RFC 6749 §4.1.2).
func (s *Store) ExchangeCode(ctx context.Context, raw string, check func(Code) error, grant func(Code) Grant) (Code, Grant, string, error) {
	hash := hashToken(raw)
	n, err := s.codes.UpdateQuery().Set("used_at", time.Now()).
		Where(orm.Cond("code_hash = $1", hash)).Where(orm.Cond("used_at IS NULL")).
		Where(orm.Cond("expires_at > now()")).Where(orm.Cond("deleted_at IS NULL")).Exec(ctx, s.db)
	if err != nil {
		return Code{}, Grant{}, "", fmt.Errorf("mcpoauth: spend code: %w", err)
	}
	rows, err := s.codes.FindAll(ctx, orm.Cond("code_hash = $1", hash))
	if err != nil {
		return Code{}, Grant{}, "", fmt.Errorf("mcpoauth: read code: %w", err)
	}
	if n == 0 {
		if len(rows) == 1 && rows[0].UsedAt != nil && rows[0].GrantID != nil {
			if err := s.revoke(ctx, orm.Cond("id = $1", *rows[0].GrantID)); err != nil {
				return Code{}, Grant{}, "", err
			}
		}
		return Code{}, Grant{}, "", errInvalidGrant
	}
	code := rows[0]
	if err := check(code); err != nil {
		return Code{}, Grant{}, "", err
	}
	refresh := randomToken()
	g := grant(code)
	g.RefreshHash = hashToken(refresh)
	err = orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		var err error
		if g, err = s.grants.WithTx(tx).Create(ctx, g); err != nil {
			return err
		}
		_, err = s.codes.UpdateQuery().Set("grant_id", g.ID).Where(orm.Cond("id = $1", code.ID)).Exec(ctx, tx)
		return err
	})
	if err != nil {
		return Code{}, Grant{}, "", fmt.Errorf("mcpoauth: create grant: %w", err)
	}
	return code, g, refresh, nil
}

// revoke soft-deletes the live grants matching cond.
func (s *Store) revoke(ctx context.Context, cond orm.Condition) error {
	if _, err := s.grants.UpdateQuery().Set("deleted_at", time.Now()).Where(cond).
		Where(orm.Cond("deleted_at IS NULL")).Exec(ctx, s.db); err != nil {
		return fmt.Errorf("mcpoauth: revoke: %w", err)
	}
	return nil
}

// RotateRefresh swaps a grant's refresh token for a new one and slides its
// expiry. A token that was already rotated away (a copy someone kept) revokes
// the grant.
func (s *Store) RotateRefresh(ctx context.Context, raw, clientID string, ttl time.Duration) (Grant, string, error) {
	hash := hashToken(raw)
	next := randomToken()
	var g Grant
	found := false
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		rows, err := s.grants.SelectForUpdate().Where(orm.Cond("refresh_hash = $1", hash)).All(ctx, tx)
		if err != nil || len(rows) == 0 {
			return err
		}
		found, g = true, rows[0]
		if g.ClientID != clientID || time.Now().After(g.ExpiresAt) {
			return errInvalidGrant
		}
		now := time.Now()
		g.PrevRefreshHash, g.RefreshHash, g.ExpiresAt, g.LastUsedAt = hash, hashToken(next), now.Add(ttl), &now
		_, err = s.grants.UpdateQuery().Set("prev_refresh_hash", g.PrevRefreshHash).Set("refresh_hash", g.RefreshHash).
			Set("expires_at", g.ExpiresAt).Set("last_used_at", now).Set("updated_at", now).
			Where(orm.Cond("id = $1", g.ID)).Exec(ctx, tx)
		return err
	})
	switch {
	case errors.Is(err, errInvalidGrant):
		return Grant{}, "", err
	case err != nil:
		return Grant{}, "", fmt.Errorf("mcpoauth: rotate refresh: %w", err)
	case !found:
		if err := s.revoke(ctx, orm.Cond("prev_refresh_hash = $1", hash)); err != nil {
			return Grant{}, "", err
		}
		return Grant{}, "", errInvalidGrant
	}
	return g, next, nil
}

// GrantLive reports whether the grant an MCP token names is still in force for
// that user: not revoked, not expired.
func (s *Store) GrantLive(ctx context.Context, grant, user uuid.UUID) (bool, error) {
	rows, err := s.grants.FindAll(ctx, orm.Cond("id = $1", grant), orm.Cond("user_id = $1", user),
		orm.Cond("deleted_at IS NULL"), orm.Cond("expires_at > now()"))
	if err != nil {
		return false, fmt.Errorf("mcpoauth: grant live: %w", err)
	}
	return len(rows) == 1, nil
}

// Grants lists the caller's live grants, newest first.
func (s *Store) Grants(ctx context.Context, tenant, user uuid.UUID) ([]Grant, error) {
	rows, err := orm.Select[Grant](s.grants.Meta()).Where(orm.Cond("tenant_id = $1", tenant)).
		Where(orm.Cond("user_id = $1", user)).Where(orm.Cond("deleted_at IS NULL")).
		Where(orm.Cond("expires_at > now()")).OrderBy("created_at DESC").All(ctx, s.db)
	if err != nil {
		return nil, fmt.Errorf("mcpoauth: list grants: %w", err)
	}
	return rows, nil
}

// RevokeGrant revokes one of the caller's grants; false when it isn't theirs or is gone.
func (s *Store) RevokeGrant(ctx context.Context, tenant, user, id uuid.UUID) (bool, error) {
	n, err := s.grants.UpdateQuery().Set("deleted_at", time.Now()).Where(orm.Cond("id = $1", id)).
		Where(orm.Cond("tenant_id = $1", tenant)).Where(orm.Cond("user_id = $1", user)).
		Where(orm.Cond("deleted_at IS NULL")).Exec(ctx, s.db)
	if err != nil {
		return false, fmt.Errorf("mcpoauth: revoke grant: %w", err)
	}
	return n == 1, nil
}
