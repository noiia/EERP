package auth

import (
	"context"

	"github.com/google/uuid"
)

// Identity holds the validated caller attributes injected by JWTMiddleware.
// Services filter rows by TenantID and gate actions on Roles.
type Identity struct {
	UserID   uuid.UUID
	TenantID uuid.UUID
	Roles    []string
	// Groups is the technical-name closure resolved at token-issue time (see
	// UserRepository.FindGroups) — a role's own technical_name plus every
	// role it transitively belongs to. Stamped onto the request context via
	// core/orm/access.WithGroups so the generic CRUD layer can gate fields.
	Groups []string
}

type contextKey struct{}

// IdentityFromContext retrieves the Identity injected by JWTMiddleware.
// Returns false when called outside an authenticated request.
func IdentityFromContext(ctx context.Context) (Identity, bool) {
	v, ok := ctx.Value(contextKey{}).(Identity)
	return v, ok
}

// MustIdentity retrieves the Identity or panics.
// Panicking here means the middleware wiring is broken — it is a programming
// error, not a user error, so a panic is correct.
func MustIdentity(ctx context.Context) Identity {
	v, ok := IdentityFromContext(ctx)
	if !ok {
		panic("auth: MustIdentity called outside authenticated context — check middleware wiring")
	}
	return v
}

// SetIdentity injects id into ctx. Used by JWTMiddleware.
func SetIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, contextKey{}, id)
}

// NewIdentityFromClaims builds an Identity from parsed JWT claims.
func NewIdentityFromClaims(claims *Claims) Identity {
	return Identity{
		UserID:   claims.Sub,
		TenantID: claims.Tenant,
		Roles:    claims.Roles,
		Groups:   claims.Groups,
	}
}
