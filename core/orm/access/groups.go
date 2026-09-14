package access

import "context"

// Package-level addition to access/tenant.go's pattern: the caller's resolved
// group set (a role's own technical_name plus every role transitively
// "belonged to" — see auth.UserRepository.FindGroups) travels through a
// request the same way the tenant ID does, so the generic CRUD layer can
// gate field visibility without importing core/internal/auth.

type groupsKey struct{}

// WithGroups returns a copy of ctx carrying the caller's resolved group set.
// The auth middleware calls this once per authenticated request, alongside
// WithTenant.
func WithGroups(ctx context.Context, groups []string) context.Context {
	return context.WithValue(ctx, groupsKey{}, groups)
}

// GroupsFromContext returns the groups stamped by WithGroups. ok is false
// when no groups were stamped (unauthenticated request, or a middleware
// wiring gap) — callers should not distinguish this from "authenticated but
// no groups", since both mean "gate every grouped field".
func GroupsFromContext(ctx context.Context) (groups []string, ok bool) {
	groups, ok = ctx.Value(groupsKey{}).([]string)
	return groups, ok
}
