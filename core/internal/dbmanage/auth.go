// Package dbmanage backs the unauthenticated /database/management page: an
// Odoo-style database manager reachable with no session at all, gated
// per-action by the same master_key secret that signs every JWT
// (internal/auth.TokenService — core/CLAUDE.md's "master_key" bullet). It is
// mounted as its OWN Echo group in main.go with no jwtMw/permMw — every
// handler in this package calls RequireMasterKey itself instead, so there is
// no accidentally-unauthenticated action, including plain listing (revealing
// live database names to an anonymous caller is real information this
// shouldn't hand out for free).
package dbmanage

import (
	"crypto/subtle"
	"net/http"

	"github.com/labstack/echo/v4"
)

// RequireMasterKey reads the X-Master-Key header and compares it against the
// configured secret in constant time (a plain == would leak the secret's
// prefix length/content through response-time side channels — the same
// concern every credential compare in this codebase takes seriously).
// Returns a JSON 401 (already written to c) and false on mismatch.
func RequireMasterKey(c echo.Context, expected string) bool {
	provided := c.Request().Header.Get("X-Master-Key")
	if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
		_ = errorJSON(c, http.StatusUnauthorized, "UNAUTHORIZED", "Invalid or missing master key.")
		return false
	}
	return true
}

// errorJSON mirrors the same {error:{code,message,request_id}} envelope every
// other hand-mounted handler in this codebase uses (internal/pictures,
// internal/attachments, internal/reports each carry their own identical copy
// rather than sharing one — following that existing convention here too).
func errorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
