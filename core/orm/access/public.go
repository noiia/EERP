package access

import (
	"context"
	"slices"
)

// PublicScope is what an anonymous website visitor may read from one table
// (ADR-024): Columns is the effective whitelist (module-declared ∩
// admin-published, plus "id"), Equals a row filter forced onto every read —
// its columns need NOT be in Columns (e.g. "published"). Stamped only by the
// /api/v1/public route group; the generic CRUD layer enforces it at the same
// choke points as field-group gating.
type PublicScope struct {
	Columns []string
	Equals  map[string]string
}

// Allows reports whether col is readable under the scope.
func (s PublicScope) Allows(col string) bool { return slices.Contains(s.Columns, col) }

type publicScopeKey struct{}

func WithPublicScope(ctx context.Context, s PublicScope) context.Context {
	return context.WithValue(ctx, publicScopeKey{}, s)
}

func PublicScopeFromContext(ctx context.Context) (PublicScope, bool) {
	s, ok := ctx.Value(publicScopeKey{}).(PublicScope)
	return s, ok
}
