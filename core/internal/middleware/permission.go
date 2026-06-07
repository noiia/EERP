package middleware

import (
	"net/http"
	"strings"

	"core/internal/auth"

	"github.com/labstack/echo/v4"
)

// PermissionMiddleware derives the required permission from the route and rejects
// callers whose roles don't grant it. Panics on missing Identity (wiring bug).
func PermissionMiddleware(perms *auth.PermissionRepository) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			identity := auth.MustIdentity(c.Request().Context())

			required := derivePermission(c)
			if required == "" {
				// Cannot derive permission — pass through (e.g. unknown route shape).
				return next(c)
			}

			ok, err := perms.Has(c.Request().Context(), identity.Roles, required)
			if err != nil {
				return err
			}
			if !ok {
				return forbidden(c)
			}
			return next(c)
		}
	}
}

// derivePermission builds "module:resource:action" from the Echo context.
func derivePermission(c echo.Context) string {
	return derivePermissionFromPath(c.Request().Method, c.Request().URL.Path)
}

// derivePermissionFromPath builds "module:resource:action" from method and URL path.
// Route shape: /api/v1/{module}/{resource}[/...].
// HTTP method maps to: GET→read, POST→write, PUT→write, DELETE→delete.
func derivePermissionFromPath(method, path string) string {
	const prefix = "/api/v1/"
	path = strings.TrimPrefix(path, prefix)

	segments := strings.SplitN(path, "/", 3)
	if len(segments) < 2 {
		return ""
	}
	mod := segments[0]
	res := segments[1]
	res = strings.SplitN(res, "/", 2)[0]

	action := methodToAction(method)
	if action == "" {
		return ""
	}
	return mod + ":" + res + ":" + action
}

func methodToAction(method string) string {
	switch method {
	case http.MethodGet:
		return "read"
	case http.MethodPost:
		return "write"
	case http.MethodPut, http.MethodPatch:
		return "write"
	case http.MethodDelete:
		return "delete"
	default:
		return ""
	}
}

func forbidden(c echo.Context) error {
	return c.JSON(http.StatusForbidden, map[string]any{
		"error": map[string]any{
			"code":       "FORBIDDEN",
			"message":    "Insufficient permissions.",
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
