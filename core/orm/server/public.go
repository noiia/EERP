package server

import (
	"context"
	"net/http"
	"strconv"

	"core/orm/access"
	"core/orm/internal/handler"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// PublicResolver answers, per request, what anonymous callers may read from
// table (ADR-024). ok=false means "not published" and yields a 404 — never an
// empty list, so the public surface cannot be enumerated.
type PublicResolver func(ctx context.Context, table string) (access.PublicScope, bool, error)

// MountPublic mounts read-only GET list + GET :id for every table declaring
// public fields, reusing the generic handlers. g must carry NO JWT or
// permission middleware — the scope is the only gate (see ADR-024 pitfalls).
func MountPublic(g *echo.Group, handlers map[string]*handler.GenericHandler, resolve PublicResolver, pictures PictureServer) {
	for _, h := range handlers {
		meta := h.Meta()
		if meta.Excluded || len(meta.PublicFields) == 0 {
			continue
		}
		mw := PublicScopeMiddleware(meta.TableName, resolve)
		prefix := "/" + meta.RoutePrefix
		g.GET(prefix, h.List, mw)
		g.GET(prefix+"/:id", h.GetByID, mw)
		if pictures != nil {
			g.GET(prefix+"/:id/picture/:field", publicPicture(meta.TableName, h.Visible, pictures), mw)
		}
	}
}

// PictureServer streams the picture anchored on (table, record, field).
type PictureServer func(c *echo.Context, table string, recordID uuid.UUID, field string) error

// publicPicture serves a picture only when field is in the caller's public
// scope and the record itself is visible under it (forced filter included).
func publicPicture(table string, visible func(context.Context, uuid.UUID) (bool, error), serve PictureServer) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		scope, _ := access.PublicScopeFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		field := c.Param("field")
		if err != nil || !scope.Allows(field) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		ok, err := visible(ctx, id)
		if err != nil {
			return err
		}
		if !ok {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		return serve(c, table, id, field)
	}
}

// maxPublicPageSize caps page_size on the anonymous surface.
const maxPublicPageSize = 100

// PublicScopeMiddleware resolves table's scope and stamps it on the context.
func PublicScopeMiddleware(table string, resolve PublicResolver) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if c.QueryParam("aggregate") != "" {
				return echo.NewHTTPError(http.StatusBadRequest, "aggregate is not available on public routes")
			}
			// Anonymous callers get a hard page cap: an unbounded page_size is a
			// one-request DoS on a large published table.
			if ps, _ := strconv.Atoi(c.QueryParam("page_size")); ps > maxPublicPageSize {
				return echo.NewHTTPError(http.StatusBadRequest, "page_size must be at most 100")
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
