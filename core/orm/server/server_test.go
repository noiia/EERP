package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/testdb"
	"core/orm"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	ormserver "core/orm/server"

	"github.com/labstack/echo/v5"
)

// ── helpers ───────────────────────────────────────────────────────────────────

// buildHandler creates a GenericHandler suitable for route-registration tests.
// The repository has a nil executor — never call service methods with it.
func buildHandler(routePrefix string, softDelete bool) *handler.GenericHandler {
	meta := registry.TableMeta{
		TableName:   routePrefix,
		RoutePrefix: routePrefix,
		SoftDelete:  softDelete,
	}
	repo := crud.NewRepository(nil, meta)
	svc := crud.NewService(repo, meta)
	return handler.NewGenericHandler(svc, meta)
}

// routeSet returns a set of "METHOD /path" strings for all registered routes.
func routeSet(e *echo.Echo) map[string]bool {
	set := make(map[string]bool)
	for _, r := range e.Router().Routes() {
		set[r.Method+" "+r.Path] = true
	}
	return set
}

// mount registers h the way production does (RegisterRoutes) and returns the Echo.
func mount(h *handler.GenericHandler) *echo.Echo {
	s := ormserver.New(nil, ormserver.Config{})
	s.RegisterRoutes(map[string]*handler.GenericHandler{"h": h}, nil)
	return s.Echo()
}

// doErrorRequest registers a one-shot route returning err, then GETs it.
func doErrorRequest(t *testing.T, returnErr error) *httptest.ResponseRecorder {
	t.Helper()
	e := ormserver.New(nil, ormserver.Config{}).Echo()
	e.GET("/probe", func(c *echo.Context) error { return returnErr })
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestNew_NilApp_ReturnsEcho(t *testing.T) {
	if ormserver.New(nil, ormserver.Config{}).Echo() == nil {
		t.Fatal("New(nil).Echo() returned nil")
	}
}

// ── New ───────────────────────────────────────────────────────────────────────

func TestNew_EmptyConfig_NoPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("New panicked: %v", r)
		}
	}()
	_ = ormserver.New(nil, ormserver.Config{})
}

// ── Route registration ────────────────────────────────────────────────────────

func TestMountHandler_BaseRoutes_Registered(t *testing.T) {
	e := mount(buildHandler("items", false))

	routes := routeSet(e)
	want := []string{
		"GET /api/v1/items",
		"GET /api/v1/items/:id",
		"POST /api/v1/items",
		"PUT /api/v1/items/:id",
		"DELETE /api/v1/items/:id",
	}
	for _, r := range want {
		if !routes[r] {
			t.Errorf("route %q not registered; registered: %v", r, routes)
		}
	}
}

func TestMountHandler_SoftDelete_RestoreRoutePresent(t *testing.T) {
	e := mount(buildHandler("things", true))

	routes := routeSet(e)
	if !routes["POST /api/v1/things/:id/restore"] {
		t.Errorf("restore route missing for soft-delete table; registered: %v", routes)
	}
}

func TestMountHandler_NoSoftDelete_NoRestoreRoute(t *testing.T) {
	e := mount(buildHandler("hards", false))

	routes := routeSet(e)
	if routes["POST /api/v1/hards/:id/restore"] {
		t.Error("restore route must not be registered for non-soft-delete table")
	}
}

func TestMountHandler_SoftDelete_AllSixRoutes(t *testing.T) {
	e := mount(buildHandler("widgets", true))

	routes := routeSet(e)
	want := []string{
		"GET /api/v1/widgets",
		"GET /api/v1/widgets/:id",
		"POST /api/v1/widgets",
		"PUT /api/v1/widgets/:id",
		"DELETE /api/v1/widgets/:id",
		"POST /api/v1/widgets/:id/restore",
	}
	for _, r := range want {
		if !routes[r] {
			t.Errorf("route %q not registered; registered: %v", r, routes)
		}
	}
}

// ── Server.RegisterRoutes / Routes ────────────────────────────────────────────

func TestServer_Routes_NonEmptyAfterRegister(t *testing.T) {
	s := ormserver.New(nil, ormserver.Config{})
	h := buildHandler("orders", true)
	s.RegisterRoutes(map[string]*handler.GenericHandler{"orders": h}, nil)

	if len(s.Routes()) == 0 {
		t.Error("Routes() returned empty slice after RegisterRoutes")
	}
}

// ── Error handler ─────────────────────────────────────────────────────────────

func TestErrorHandler_404_ReturnsNotFoundCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusNotFound, "not found"))

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	var body ormserver.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Error.Code != "NOT_FOUND" {
		t.Errorf("code = %q, want NOT_FOUND", body.Error.Code)
	}
}

func TestErrorHandler_400_ReturnsBadRequestCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusBadRequest, "bad input"))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Error.Code != "BAD_REQUEST" {
		t.Errorf("code = %q, want BAD_REQUEST", body.Error.Code)
	}
}

func TestErrorHandler_422_ReturnsUnprocessableCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusUnprocessableEntity, "validation failed"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Error.Code != "UNPROCESSABLE" {
		t.Errorf("code = %q, want UNPROCESSABLE", body.Error.Code)
	}
}

func TestErrorHandler_401_ReturnsUnauthorizedCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusUnauthorized, "unauthorized"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Error.Code != "UNAUTHORIZED" {
		t.Errorf("code = %q, want UNAUTHORIZED", body.Error.Code)
	}
}

func TestErrorHandler_403_ReturnsForbiddenCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusForbidden, "forbidden"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Error.Code != "FORBIDDEN" {
		t.Errorf("code = %q, want FORBIDDEN", body.Error.Code)
	}
}

func TestErrorHandler_UnknownHTTPStatus_ReturnsErrorCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusTeapot, "i am a teapot"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Error.Code != "ERROR" {
		t.Errorf("code = %q, want ERROR for unknown status", body.Error.Code)
	}
}

func TestErrorHandler_PlainError_Returns500WithInternalCode(t *testing.T) {
	e := ormserver.New(nil, ormserver.Config{}).Echo()
	e.GET("/boom", func(c *echo.Context) error {
		return &plainError{"something exploded"}
	})
	req := httptest.NewRequest(http.MethodGet, "/boom", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	var body ormserver.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Error.Code != "INTERNAL_ERROR" {
		t.Errorf("code = %q, want INTERNAL_ERROR", body.Error.Code)
	}
	if body.Error.Message != "internal server error" {
		t.Errorf("message = %q, want %q", body.Error.Message, "internal server error")
	}
}

type plainError struct{ msg string }

func (e *plainError) Error() string { return e.msg }

// ── AuthRateLimiter ───────────────────────────────────────────────────────────

func TestAuthRateLimiter_BlocksAfterBurst(t *testing.T) {
	e := echo.New()
	e.GET("/x", func(c *echo.Context) error { return c.NoContent(http.StatusOK) },
		ormserver.AuthRateLimiter(2)) // burst = 2

	codes := make([]int, 0, 4)
	for i := 0; i < 4; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "203.0.113.7:5555" // same client IP → shared bucket
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		codes = append(codes, rec.Code)
	}

	if codes[0] != http.StatusOK || codes[1] != http.StatusOK {
		t.Fatalf("first two requests should pass, got %v", codes)
	}
	if codes[3] != http.StatusTooManyRequests {
		t.Errorf("expected 429 once the burst is exhausted, got %v", codes)
	}
}

// Behind nginx/Next every request comes from a private address; the rate
// limiters must key on the X-Forwarded-For client, not the proxy.
func TestRealIP_TrustsPrivateProxyXFF(t *testing.T) {
	tests := []struct{ name, remote, xff, want string }{
		{"proxied client", "172.18.0.5:1234", "203.0.113.7, 172.18.0.9", "203.0.113.7"},
		{"public peer cannot spoof", "198.51.100.1:1234", "203.0.113.7", "198.51.100.1"},
		{"no header", "172.18.0.5:1234", "", "172.18.0.5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := ormserver.New(nil, ormserver.Config{}).Echo()
			var got string
			e.GET("/ip", func(c *echo.Context) error { got = c.RealIP(); return c.NoContent(http.StatusOK) })
			req := httptest.NewRequest(http.MethodGet, "/ip", nil)
			req.RemoteAddr = tt.remote
			if tt.xff != "" {
				req.Header.Set("X-Forwarded-For", tt.xff)
			}
			e.ServeHTTP(httptest.NewRecorder(), req)
			if got != tt.want {
				t.Errorf("RealIP = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHealth(t *testing.T) {
	up := testdb.Open(t)
	down := testdb.Open(t)
	down.DB.Close() // a closed pool fails its ping like an unreachable database

	tests := []struct {
		name string
		app  *orm.App
		want int
	}{
		{"no database wired", nil, http.StatusOK},
		{"database reachable", up, http.StatusOK},
		{"database unreachable", down, http.StatusServiceUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := ormserver.New(tt.app, ormserver.Config{}).Echo()
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
			if rec.Code != tt.want {
				t.Errorf("status = %d, want %d (%s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
}

// v5's router sentinels (echo.ErrNotFound, ErrMethodNotAllowed) are no longer
// *echo.HTTPError: an unmatched route must still answer 404 NOT_FOUND, not 500.
func TestErrorHandler_UnmatchedRoute_Returns404(t *testing.T) {
	e := ormserver.New(nil, ormserver.Config{}).Echo()
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))

	var body ormserver.ErrorResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusNotFound || body.Error.Code != "NOT_FOUND" {
		t.Fatalf("status=%d code=%q, want 404 NOT_FOUND", rec.Code, body.Error.Code)
	}
}

func TestBodyLimit_ParsesConfigSize(t *testing.T) {
	for _, tc := range []struct {
		limit string
		size  int
		want  int
	}{
		{"1K", 1024, http.StatusOK},
		{"1K", 1025, http.StatusRequestEntityTooLarge},
		{"", 1 << 20, http.StatusOK},
		{"bogus", 1<<20 + 1, http.StatusRequestEntityTooLarge},
	} {
		t.Run(tc.limit, func(t *testing.T) {
			e := ormserver.New(nil, ormserver.Config{BodyLimit: tc.limit}).Echo()
			e.POST("/p", func(c *echo.Context) error { return c.NoContent(http.StatusOK) })
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/p", strings.NewReader(strings.Repeat("x", tc.size))))
			if rec.Code != tc.want {
				t.Fatalf("limit %q, %d bytes: status %d, want %d", tc.limit, tc.size, rec.Code, tc.want)
			}
		})
	}
}

// An exempt prefix skips the global cap and is bounded by its own BodyLimit;
// a look-alike path ("/up-x") and everything else keep the global cap.
func TestBodyLimit_ExemptPrefixUsesOwnLimit(t *testing.T) {
	e := ormserver.New(nil, ormserver.Config{BodyLimit: "1K", BodyLimitExempt: []string{"/up"}}).Echo()
	ok := func(c *echo.Context) error { return c.NoContent(http.StatusOK) }
	e.Group("/up", ormserver.BodyLimit("4K")).POST("/file", ok)
	e.POST("/up-x", ok)
	e.POST("/json", ok)
	for _, tc := range []struct {
		path string
		size int
		want int
	}{
		{"/up/file", 2048, http.StatusOK},
		{"/up/file", 4097, http.StatusRequestEntityTooLarge},
		{"/up-x", 2048, http.StatusRequestEntityTooLarge},
		{"/json", 2048, http.StatusRequestEntityTooLarge},
		{"/json", 1024, http.StatusOK},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.path, tc.size), func(t *testing.T) {
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(strings.Repeat("x", tc.size))))
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}
