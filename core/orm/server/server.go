// Package server bootstraps an Echo HTTP server that serves the auto-generated
// CRUD routes. It is a public package so cmd/server/main.go can import it
// without violating Go's internal package rules.
package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"core/orm"
	"core/orm/internal/handler"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"go.uber.org/zap"
)

// Config holds HTTP server settings.
type Config struct {
	Addr string // bind address, e.g. "0.0.0.0:8080"
	// AllowOrigins is the CORS allow-list. Empty falls back to "*" (dev only).
	AllowOrigins []string
	// BodyLimit caps request body size (e.g. "1M"). Empty defaults to "1M".
	BodyLimit string
}

// Server wraps an Echo instance and the App.
type Server struct {
	echo *echo.Echo
	cfg  Config
	app  *orm.App
}

// ErrorResponse is the uniform error body shape — the same
// {"error":{"code","message","request_id"}} envelope every dedicated
// handler package's own errorJSON helper already produces (see
// core-front/CLAUDE.md's Conventions table), so the frontend's parseError()
// has exactly one shape to read regardless of which package produced the
// error. Previously this was a flat {"error": "<string>", "code": "..."}
// shape unique to this package — parseError() only ever recognized the
// object form, so a caller falling through to this handler (or to generic
// CRUD's own validation response, see internal/handler/generic_handler.go)
// silently lost its real message and fell back to a generic one.
type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}

// ErrorBody is the nested {code, message, request_id} object every error
// envelope in this codebase carries under "error".
type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

// New creates a Server with the standard middleware stack:
// RequestID → zap logger → Recover → BodyLimit → CORS.
func New(app *orm.App, cfg Config) *Server {
	if cfg.Addr == "" {
		cfg.Addr = ":8080"
	}

	e := newEcho(app, cfg)
	return &Server{echo: e, cfg: cfg, app: app}
}

func newEcho(app *orm.App, cfg Config) *echo.Echo {
	e := echo.New()

	// Every request reaches Go through nginx and/or the Next BFF (private
	// addresses), so RealIP — what the rate limiters key on — must come from
	// X-Forwarded-For, trusting only loopback/link-local/private hops.
	e.IPExtractor = echo.ExtractIPFromXFFHeader(echo.TrustPrivateNet(true))

	e.Use(middleware.RequestID())

	if app != nil && app.Logger != nil {
		e.Use(zapMiddleware(app.Logger))
	}

	e.Use(middleware.Recover())

	// Cap request bodies to bound memory use / basic DoS. Default 1M.
	e.Use(middleware.BodyLimit(parseByteSize(cfg.BodyLimit)))

	// CORS: restrict to configured origins; fall back to "*" only when unset (dev).
	allowOrigins := cfg.AllowOrigins
	if len(allowOrigins) == 0 {
		allowOrigins = []string{"*"}
	}
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: allowOrigins,
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))

	// Liveness + DB readiness for the compose healthcheck and the gateway's
	// /health: 200 once the server answers AND the pool reaches Postgres.
	e.GET("/health", healthHandler(app))

	if app != nil && app.Logger != nil {
		e.HTTPErrorHandler = newErrorHandler(app.Logger)
	} else {
		e.HTTPErrorHandler = newErrorHandler(nil)
	}

	return e
}

// AuthRateLimiter returns an in-memory, per-IP rate limiter for the public auth
// endpoints, to blunt credential brute-forcing. perMinute requests are allowed per
// client IP (burst = perMinute); it defaults to 20/min when perMinute <= 0.
func AuthRateLimiter(perMinute int) echo.MiddlewareFunc {
	if perMinute <= 0 {
		perMinute = 20
	}
	store := middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
		Rate:      float64(perMinute) / 60.0, // tokens per second
		Burst:     perMinute,
		ExpiresIn: 3 * time.Minute,
	})
	return middleware.RateLimiter(store)
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
func (s *Server) Routes() echo.Routes {
	return s.echo.Router().Routes()
}

// Echo returns the underlying Echo instance.
// Use to mount custom route groups (e.g. auth endpoints) without middleware.
func (s *Server) Echo() *echo.Echo {
	return s.echo
}

// Start binds the server and blocks until ctx is cancelled, then drains
// in-flight requests for up to 10 seconds (echo's StartConfig graceful shutdown).
func (s *Server) Start(ctx context.Context) error {
	sc := echo.StartConfig{
		Address:         s.cfg.Addr,
		HideBanner:      true,
		HidePort:        true,
		GracefulTimeout: 10 * time.Second,
		// StartConfig defaults ReadTimeout to 30s, which would cut long-lived
		// presence websockets and large /database-management restores. Keep the
		// v4 behaviour (no whole-request deadline) and bound only the headers.
		BeforeServeFunc: func(srv *http.Server) error {
			srv.ReadTimeout = 0
			srv.ReadHeaderTimeout = 10 * time.Second
			return nil
		},
	}
	if err := sc.Start(ctx, s.echo); err != nil {
		return fmt.Errorf("server: listen: %w", err)
	}
	return nil
}

// ── Middleware ────────────────────────────────────────────────────────────────

func zapMiddleware(logger *zap.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			req := c.Request()
			start := time.Now()
			err := next(c)

			// The error handler writes an uncommitted error after we return, so
			// resolve the status it will send rather than the still-default 200.
			_, status := echo.ResolveResponseStatus(c.Response(), err)

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
	return func(c *echo.Context, err error) {
		if resp, _ := echo.UnwrapResponse(c.Response()); resp != nil && resp.Committed {
			return
		}

		requestID := c.Response().Header().Get(echo.HeaderXRequestID)

		// echo.StatusCode also matches v5's predefined sentinels (ErrNotFound,
		// ErrMethodNotAllowed, ...), which are no longer *echo.HTTPError.
		if code := echo.StatusCode(err); code != 0 {
			msg := http.StatusText(code)
			var he *echo.HTTPError
			if errors.As(err, &he) && he.Message != "" {
				msg = he.Message
			}
			// A wrapped cause (e.g. the pg error behind a constraint 400) is
			// for the operator, never the response.
			if he != nil && he.Unwrap() != nil && logger != nil {
				logger.Warn("request error", zap.Int("status", code), zap.Error(he.Unwrap()), zap.String("request_id", requestID))
			}
			_ = c.JSON(code, ErrorResponse{Error: ErrorBody{Code: httpCode(code), Message: msg, RequestID: requestID}})
			return
		}

		if logger != nil {
			logger.Error("unhandled error",
				zap.Error(err),
				zap.String("request_id", requestID),
			)
		}
		_ = c.JSON(http.StatusInternalServerError, ErrorResponse{
			Error: ErrorBody{Code: "INTERNAL_ERROR", Message: "internal server error", RequestID: requestID},
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

// healthHandler reports 503 when the database doesn't answer a ping within 2s.
// A nil app (no database wired) is healthy as soon as the server answers.
func healthHandler(app *orm.App) echo.HandlerFunc {
	return func(c *echo.Context) error {
		if app != nil && app.DB != nil {
			ctx, cancel := context.WithTimeout(c.Request().Context(), 2*time.Second)
			defer cancel()
			if err := app.DB.Pool().Ping(ctx); err != nil {
				return c.JSON(http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
			}
		}
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	}
}

// parseByteSize turns a config size like "1M", "512K" or "2G" (case-insensitive,
// optional trailing "B") into bytes. Empty or malformed input falls back to 1M.
func parseByteSize(v string) int64 {
	const def = 1 << 20
	v = strings.TrimSuffix(strings.ToUpper(strings.TrimSpace(v)), "B")
	if v == "" {
		return def
	}
	mult := int64(1)
	switch v[len(v)-1] {
	case 'K':
		mult = 1 << 10
	case 'M':
		mult = 1 << 20
	case 'G':
		mult = 1 << 30
	}
	if mult > 1 {
		v = v[:len(v)-1]
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return def
	}
	return n * mult
}
