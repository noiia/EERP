package auth

import (
	"fmt"
	"time"

	"core/internal/types"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Claims is the JWT payload for access tokens.
type Claims struct {
	Sub    uuid.UUID `json:"sub"`
	Tenant uuid.UUID `json:"tenant"`
	Roles  []string  `json:"roles"`
	// Permissions carries the role-derived permission codes so the frontend's
	// session mirror can gate UI (Create buttons, <Can>) without a round-trip.
	// UI convenience only — Go still authorizes every call from the DB, so a
	// stale claim (grants changed mid-token) can never widen real access.
	Permissions []string `json:"permissions,omitempty"`
	jwt.RegisteredClaims
}

// TokenService issues and validates HS256 JWTs signed with master_key.
type TokenService struct {
	cfg *types.Config
}

// NewTokenService constructs a TokenService. cfg must have a non-empty MasterPassword.
func NewTokenService(cfg *types.Config) *TokenService {
	return &TokenService{cfg: cfg}
}

// IssueAccess issues a signed access token embedding user ID, tenant ID, roles,
// and the role-derived permission codes (see Claims.Permissions).
func (t *TokenService) IssueAccess(user Users, roles []string, permissions []string) (string, error) {
	ttl := t.accessTTL()
	claims := Claims{
		Sub:         user.ID,
		Tenant:      user.TenantID,
		Roles:       roles,
		Permissions: permissions,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID.String(),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(t.cfg.MasterPassword))
	if err != nil {
		return "", fmt.Errorf("token: sign access: %w", err)
	}
	return signed, nil
}

// IssueRefresh issues a minimal signed refresh token (sub only, no roles).
func (t *TokenService) IssueRefresh(userID uuid.UUID) (string, error) {
	ttl := t.refreshTTL()
	claims := jwt.RegisteredClaims{
		Subject:   userID.String(),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(t.cfg.MasterPassword))
	if err != nil {
		return "", fmt.Errorf("token: sign refresh: %w", err)
	}
	return signed, nil
}

// ParseAccess validates a raw access token and returns the claims.
func (t *TokenService) ParseAccess(raw string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(raw, &Claims{}, t.keyFunc())
	if err != nil {
		return nil, fmt.Errorf("token: parse access: %w", err)
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("token: parse access: invalid claims")
	}
	return claims, nil
}

// ParseRefresh validates a raw refresh token and returns the user ID.
func (t *TokenService) ParseRefresh(raw string) (uuid.UUID, error) {
	token, err := jwt.ParseWithClaims(raw, &jwt.RegisteredClaims{}, t.keyFunc())
	if err != nil {
		return uuid.Nil, fmt.Errorf("token: parse refresh: %w", err)
	}
	claims, ok := token.Claims.(*jwt.RegisteredClaims)
	if !ok || !token.Valid {
		return uuid.Nil, fmt.Errorf("token: parse refresh: invalid claims")
	}
	id, err := uuid.Parse(claims.Subject)
	if err != nil {
		return uuid.Nil, fmt.Errorf("token: parse refresh: bad subject: %w", err)
	}
	return id, nil
}

func (t *TokenService) keyFunc() jwt.Keyfunc {
	return func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("token: unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(t.cfg.MasterPassword), nil
	}
}

func (t *TokenService) accessTTL() time.Duration {
	return t.accessTTLDuration()
}

func (t *TokenService) accessTTLDuration() time.Duration {
	if t.cfg.AccessTTLSeconds > 0 {
		return time.Duration(t.cfg.AccessTTLSeconds) * time.Second
	}
	return time.Hour
}

func (t *TokenService) accessTTLSeconds() int {
	if t.cfg.AccessTTLSeconds > 0 {
		return t.cfg.AccessTTLSeconds
	}
	return 3600
}

func (t *TokenService) refreshTTL() time.Duration {
	return t.refreshTTLDuration()
}

func (t *TokenService) refreshTTLDuration() time.Duration {
	if t.cfg.RefreshTTLSeconds > 0 {
		return time.Duration(t.cfg.RefreshTTLSeconds) * time.Second
	}
	return 7 * 24 * time.Hour
}
