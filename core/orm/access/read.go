package access

import "context"

// Per-request "may the caller read table X" check, stamped by the permission
// middleware (it evaluates <table>:<table>:read for the caller's roles) so the
// generic CRUD layer can authorize a reference to ANOTHER table — a geo
// `inside` filter, a distance — without importing core/internal/auth.

type readCheckKey struct{}

// WithReadCheck returns ctx carrying the caller's read check.
func WithReadCheck(ctx context.Context, canRead func(table string) bool) context.Context {
	return context.WithValue(ctx, readCheckKey{}, canRead)
}

// CanRead reports whether the caller may read table. False when no check was
// stamped (anonymous/public request, wiring gap): fail closed.
func CanRead(ctx context.Context, table string) bool {
	fn, ok := ctx.Value(readCheckKey{}).(func(string) bool)
	return ok && fn(table)
}
