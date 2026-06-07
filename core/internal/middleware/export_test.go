package middleware

// DerivePermission exports derivePermission for unit tests.
// Takes method and path directly instead of echo.Context so tests don't need an HTTP stack.
func DerivePermission(method, path string) string {
	return derivePermissionFromPath(method, path)
}
