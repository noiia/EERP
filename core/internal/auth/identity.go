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
	// MustChangePassword mirrors Claims.MustChangePassword — see its own doc
	// comment. Read by PermissionMiddleware, not by any handler.
	MustChangePassword bool
	// GrantID is set for an OAuth MCP token (Claims.GrantID), uuid.Nil otherwise.
	GrantID uuid.UUID
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
		UserID:             claims.Sub,
		TenantID:           claims.Tenant,
		Roles:              claims.Roles,
		Groups:             claims.Groups,
		MustChangePassword: claims.MustChangePassword,
		GrantID:            claims.GrantID,
	}
}

type mcpRequestKey struct{}

// WithMCPRequest marks ctx as the MCP endpoint's request, or an API call MCP
// makes on its behalf: the only places an "mcp" audience token is accepted.
// A context value, so no client can set it.
func WithMCPRequest(ctx context.Context) context.Context {
	return context.WithValue(ctx, mcpRequestKey{}, true)
}

// IsMCPRequest reports whether ctx was marked by WithMCPRequest.
func IsMCPRequest(ctx context.Context) bool {
	v, _ := ctx.Value(mcpRequestKey{}).(bool)
	return v
}
