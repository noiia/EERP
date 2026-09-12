package middleware

import (
	"context"
	"net/http"
	"strings"

	"core/internal/auth"

	"github.com/labstack/echo/v4"
)

// permissionChecker is the call-site interface the middleware needs from the
// permission repository — defined here (not at the implementation) per convention,
// and so the middleware can be unit-tested with a stub. *auth.PermissionRepository
// satisfies it.
type permissionChecker interface {
	Has(ctx context.Context, roles []string, required string) (bool, error)
}

// PermissionMiddleware derives the required permission from the route and rejects
// callers whose roles don't grant it. Panics on missing Identity (wiring bug).
func PermissionMiddleware(perms permissionChecker) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			identity := auth.MustIdentity(c.Request().Context())

			required := derivePermission(c)
			if required == "" {
				// Fail closed: if the required permission can't be determined for a
				// protected route, deny. Every generic CRUD route yields a permission;
				// an empty result means an unexpected method or route shape, which must
				// not silently bypass authorization.
				return forbidden(c)
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

// derivePermission builds "module:resource:action" from the matched route.
// It uses Echo's route pattern (c.Path(), e.g. "/api/v1/contacts/:id") rather than
// the raw URL, so path parameters never leak into the permission: the item route and
// the collection route for a table resolve to the SAME permission.
func derivePermission(c echo.Context) string {
	return derivePermissionFromRoute(c.Request().Method, c.Path())
}

// derivePermissionFromRoute builds "module:resource:action" from the HTTP method and
// a matched route pattern under /api/v1/.
//
// The resource is named by the static segments BEFORE the first path parameter, so
// item, collection and restore routes for a table all resolve consistently:
//
//	/api/v1/{table}                 -> table:table:action    (flat: table is its own module)
//	/api/v1/{table}/:id             -> table:table:action    (identical to the collection)
//	/api/v1/{table}/:id/restore     -> table:table:write     ("restore" folds into the method)
//	/api/v1/{module}/{resource}...  -> module:resource:action
//
// Returns "" when no static resource segment remains or the method is unknown; the
// middleware treats "" as a denial (fail closed).
func derivePermissionFromRoute(method, routePath string) string {
	const prefix = "/api/v1/"
	trimmed := strings.TrimPrefix(routePath, prefix)

	// Collect the static prefix segments up to the first path parameter. The id and
	// any action suffix (e.g. "restore") sit at/after ":id" and do not name the
	// resource — the method carries the action.
	var segs []string
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == "" {
			continue
		}
		if strings.HasPrefix(seg, ":") {
			break
		}
		segs = append(segs, seg)
	}
	if len(segs) == 0 {
		return ""
	}

	mod := segs[0]
	res := mod // flat route: table is its own module
	if len(segs) >= 2 {
		res = segs[1]
	}

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
