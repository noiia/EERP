package server

import (
	"context"
	"net/http"

	"core/orm/access"
	"core/orm/internal/handler"

	"github.com/labstack/echo/v5"
)

// PublicResolver answers, per request, what anonymous callers may read from
// table (ADR-024). ok=false means "not published" and yields a 404 — never an
// empty list, so the public surface cannot be enumerated.
type PublicResolver func(ctx context.Context, table string) (access.PublicScope, bool, error)

// MountPublic mounts read-only GET list + GET :id for every table declaring
// public fields, reusing the generic handlers. g must carry NO JWT or
// permission middleware — the scope is the only gate (see ADR-024 pitfalls).
func MountPublic(g *echo.Group, handlers map[string]*handler.GenericHandler, resolve PublicResolver) {
	for _, h := range handlers {
		meta := h.Meta()
		if meta.Excluded || len(meta.PublicFields) == 0 {
			continue
		}
		mw := PublicScopeMiddleware(meta.TableName, resolve)
		prefix := "/" + meta.RoutePrefix
		g.GET(prefix, h.List, mw)
		g.GET(prefix+"/:id", h.GetByID, mw)
	}
}

// PublicScopeMiddleware resolves table's scope and stamps it on the context.
func PublicScopeMiddleware(table string, resolve PublicResolver) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if c.QueryParam("aggregate") != "" {
				return echo.NewHTTPError(http.StatusBadRequest, "aggregate is not available on public routes")
			}
			ctx := c.Request().Context()
			scope, ok, err := resolve(ctx, table)
			if err != nil {
				return err
			}
			if !ok {
				return echo.NewHTTPError(http.StatusNotFound, "not found")
			}
			c.SetRequest(c.Request().WithContext(access.WithPublicScope(ctx, scope)))
			return next(c)
		}
	}
}
