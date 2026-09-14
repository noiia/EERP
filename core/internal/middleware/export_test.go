package middleware

// DerivePermission exports derivePermissionFromRoute for unit tests.
// routePath is a matched Echo route pattern (may contain ":id" params), so tests
// don't need a live HTTP stack.
func DerivePermission(method, routePath string) string {
	return derivePermissionFromRoute(method, routePath)
}
