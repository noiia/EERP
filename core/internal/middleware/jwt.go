package middleware

import (
	"net/http"
	"strings"

	"core/internal/auth"

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
			raw := strings.TrimPrefix(header, "Bearer ")

			claims, err := tokens.ParseAccess(raw)
			if err != nil {
				return unauthenticated(c)
			}

			identity := auth.NewIdentityFromClaims(claims)
			ctx := auth.SetIdentity(c.Request().Context(), identity)
			c.SetRequest(c.Request().WithContext(ctx))
			return next(c)
		}
	}
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
