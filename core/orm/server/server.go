// Package server bootstraps an Echo HTTP server that serves the auto-generated
// CRUD routes. It is a public package so cmd/server/main.go can import it
// without violating Go's internal package rules.
package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"core/orm"
	"core/orm/internal/handler"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"go.uber.org/zap"
)

// Config holds HTTP server settings.
type Config struct {
	Addr string // bind address, e.g. "0.0.0.0:8080"
}

// Server wraps an Echo instance and the App.
type Server struct {
	echo *echo.Echo
	cfg  Config
	app  *orm.App
}

// ErrorResponse is the uniform error body shape.
type ErrorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

// New creates a Server with the standard middleware stack:
// RequestID → zap logger → Recover → CORS.
func New(app *orm.App, cfg Config) *Server {
	if cfg.Addr == "" {
		cfg.Addr = ":8080"
	}

	e := NewEcho(app)
	return &Server{echo: e, cfg: cfg, app: app}
}

// NewEcho creates a configured Echo instance without binding it to a port.
// Exposed so integration tests can get an httptest-friendly Echo.
func NewEcho(app *orm.App) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	e.Use(middleware.RequestID())

	if app != nil && app.Logger != nil {
		e.Use(zapMiddleware(app.Logger))
	}

	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))

	if app != nil && app.Logger != nil {
		e.HTTPErrorHandler = newErrorHandler(app.Logger)
	} else {
		e.HTTPErrorHandler = newErrorHandler(nil)
	}

	return e
}

// RegisterRoutes mounts each handler's routes under /api/v1 with optional
// JWT and permission middleware on the protected group.
// authGroup receives public auth routes (no middleware).
// jwtMw and permMw are applied to all other /api/v1 routes when non-nil.
func (s *Server) RegisterRoutes(
	handlers map[string]*handler.GenericHandler,
	authGroup func(*echo.Echo),
	middlewares ...echo.MiddlewareFunc,
) {
	if authGroup != nil {
		authGroup(s.echo)
	}

	g := s.echo.Group("/api/v1", middlewares...)
	for _, h := range handlers {
		mountHandler(g, h)
	}
}

// MountHandler mounts an individual handler on a group.
// Exported for use in integration tests.
func MountHandler(e *echo.Echo, h *handler.GenericHandler, middlewares ...echo.MiddlewareFunc) {
	g := e.Group("/api/v1", middlewares...)
	mountHandler(g, h)
}

func mountHandler(g *echo.Group, h *handler.GenericHandler) {
	meta := h.Meta()
	prefix := "/" + meta.RoutePrefix

	g.GET(prefix, h.List)
	g.GET(prefix+"/:id", h.GetByID)
	g.POST(prefix, h.Create)
	g.PUT(prefix+"/:id", h.Update)
	g.DELETE(prefix+"/:id", h.Delete)

	if meta.SoftDelete {
		g.POST(prefix+"/:id/restore", h.Restore)
	}
}

// Routes returns every route registered on the Echo instance.
// Useful for logging mounted endpoints at startup.
func (s *Server) Routes() []*echo.Route {
	return s.echo.Routes()
}

// Echo returns the underlying Echo instance.
// Use to mount custom route groups (e.g. auth endpoints) without middleware.
func (s *Server) Echo() *echo.Echo {
	return s.echo
}

// Start binds the server and blocks until ctx is cancelled.
// Initiates graceful shutdown with a 10-second drain window.
func (s *Server) Start(ctx context.Context) error {
	errCh := make(chan error, 1)

	go func() {
		if err := s.echo.Start(s.cfg.Addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("server: listen: %w", err)
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.echo.Shutdown(shutCtx); err != nil {
			return fmt.Errorf("server: shutdown: %w", err)
		}
		return nil
	}
}

// ── Middleware ────────────────────────────────────────────────────────────────

func zapMiddleware(logger *zap.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			req := c.Request()
			start := time.Now()
			err := next(c)

			// Derive the actual status: if the handler returned an error without
			// committing a response, the error handler will write it after we return —
			// so we predict the status here rather than reading the still-default 200.
			status := c.Response().Status
			if err != nil && !c.Response().Committed {
				var he *echo.HTTPError
				if errors.As(err, &he) {
					status = he.Code
				} else {
					status = http.StatusInternalServerError
				}
			}

			logger.Info("request",
				zap.String("method", req.Method),
				zap.String("uri", req.RequestURI),
				zap.Int("status", status),
				zap.Duration("latency", time.Since(start)),
				zap.String("request_id", c.Response().Header().Get(echo.HeaderXRequestID)),
			)
			return err
		}
	}
}

// ── Error handler ─────────────────────────────────────────────────────────────

func newErrorHandler(logger *zap.Logger) echo.HTTPErrorHandler {
	return func(err error, c echo.Context) {
		if c.Response().Committed {
			return
		}

		var he *echo.HTTPError
		if errors.As(err, &he) {
			code := he.Code
			msg := fmt.Sprintf("%v", he.Message)
			_ = c.JSON(code, ErrorResponse{Error: msg, Code: httpCode(code)})
			return
		}

		if logger != nil {
			logger.Error("unhandled error",
				zap.Error(err),
				zap.String("request_id", c.Response().Header().Get(echo.HeaderXRequestID)),
			)
		}
		_ = c.JSON(http.StatusInternalServerError, ErrorResponse{
			Error: "internal server error",
			Code:  "INTERNAL_ERROR",
		})
	}
}

func httpCode(status int) string {
	switch status {
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusBadRequest:
		return "BAD_REQUEST"
	case http.StatusUnprocessableEntity:
		return "UNPROCESSABLE"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "FORBIDDEN"
	default:
		return "ERROR"
	}
}
