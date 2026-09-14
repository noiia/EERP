package middleware

import (
	"net/http"
	"strings"

	"core/internal/auth"
	"core/orm/access"

	"github.com/labstack/echo/v4"
)

// JWTMiddleware validates Bearer tokens and injects Identity into the request context.
// Returns 401 for any failure — never leaks which check failed.
func JWTMiddleware(tokens *auth.TokenService) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			header := c.Request().Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				return unauthenticated(c)
			}
			return authenticate(c, next, tokens, strings.TrimPrefix(header, "Bearer "))
		}
	}
}

// JWTOrCookieMiddleware is JWTMiddleware plus ONE narrowly-scoped fallback:
// when there's no Authorization header, it reads the raw access token from
// cookieName instead. Used ONLY by the presence routes (core/cmd/app/main.go)
// — a native WebSocket handshake can't carry a custom header, but the
// browser sends the session cookie automatically on a same-origin request,
// and that cookie's value IS the same JWT this middleware already validates
// (core-front's eerp_access cookie — see ADR-019). Every other route keeps
// requiring a real Bearer header; this does not change their behavior.
func JWTOrCookieMiddleware(tokens *auth.TokenService, cookieName string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			header := c.Request().Header.Get("Authorization")
			if strings.HasPrefix(header, "Bearer ") {
				return authenticate(c, next, tokens, strings.TrimPrefix(header, "Bearer "))
			}
			cookie, err := c.Cookie(cookieName)
			if err != nil || cookie.Value == "" {
				return unauthenticated(c)
			}
			return authenticate(c, next, tokens, cookie.Value)
		}
	}
}

// authenticate parses raw as an access token and, on success, stamps the
// request context (Identity + tenant + group closure) before calling next —
// the shared body of JWTMiddleware and JWTOrCookieMiddleware.
func authenticate(c echo.Context, next echo.HandlerFunc, tokens *auth.TokenService, raw string) error {
	claims, err := tokens.ParseAccess(raw)
	if err != nil {
		return unauthenticated(c)
	}

	identity := auth.NewIdentityFromClaims(claims)
	ctx := auth.SetIdentity(c.Request().Context(), identity)
	// Stamp the tenant so the generic CRUD layer can isolate rows to this
	// caller's tenant (fail-closed on tenant-owned tables).
	ctx = access.WithTenant(ctx, identity.TenantID)
	// Stamp the resolved group closure so the generic CRUD layer can
	// omit group-gated fields (core/orm/internal/crud.BuildResponse)
	// without importing this package.
	ctx = access.WithGroups(ctx, identity.Groups)
	c.SetRequest(c.Request().WithContext(ctx))
	return next(c)
}

func unauthenticated(c echo.Context) error {
	return c.JSON(http.StatusUnauthorized, map[string]any{
		"error": map[string]any{
			"code":       "UNAUTHENTICATED",
			"message":    "Authentication required.",
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
