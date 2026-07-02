package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	ormserver "core/orm/server"

	"github.com/labstack/echo/v4"
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
	for _, r := range e.Routes() {
		set[r.Method+" "+r.Path] = true
	}
	return set
}

// doErrorRequest registers a one-shot route returning err, then GETs it.
func doErrorRequest(t *testing.T, returnErr error) *httptest.ResponseRecorder {
	t.Helper()
	e := ormserver.NewEcho(nil)
	e.GET("/probe", func(c echo.Context) error { return returnErr })
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

// ── NewEcho ───────────────────────────────────────────────────────────────────

func TestNewEcho_NilApp_ReturnsEcho(t *testing.T) {
	e := ormserver.NewEcho(nil)
	if e == nil {
		t.Fatal("NewEcho(nil) returned nil")
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
	e := ormserver.NewEcho(nil)
	ormserver.MountHandler(e, buildHandler("items", false))

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
	e := ormserver.NewEcho(nil)
	ormserver.MountHandler(e, buildHandler("things", true))

	routes := routeSet(e)
	if !routes["POST /api/v1/things/:id/restore"] {
		t.Errorf("restore route missing for soft-delete table; registered: %v", routes)
	}
}

func TestMountHandler_NoSoftDelete_NoRestoreRoute(t *testing.T) {
	e := ormserver.NewEcho(nil)
	ormserver.MountHandler(e, buildHandler("hards", false))

	routes := routeSet(e)
	if routes["POST /api/v1/hards/:id/restore"] {
		t.Error("restore route must not be registered for non-soft-delete table")
	}
}

func TestMountHandler_SoftDelete_AllSixRoutes(t *testing.T) {
	e := ormserver.NewEcho(nil)
	ormserver.MountHandler(e, buildHandler("widgets", true))

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
	if body.Code != "NOT_FOUND" {
		t.Errorf("code = %q, want NOT_FOUND", body.Code)
	}
}

func TestErrorHandler_400_ReturnsBadRequestCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusBadRequest, "bad input"))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Code != "BAD_REQUEST" {
		t.Errorf("code = %q, want BAD_REQUEST", body.Code)
	}
}

func TestErrorHandler_422_ReturnsUnprocessableCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusUnprocessableEntity, "validation failed"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Code != "UNPROCESSABLE" {
		t.Errorf("code = %q, want UNPROCESSABLE", body.Code)
	}
}

func TestErrorHandler_401_ReturnsUnauthorizedCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusUnauthorized, "unauthorized"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Code != "UNAUTHORIZED" {
		t.Errorf("code = %q, want UNAUTHORIZED", body.Code)
	}
}

func TestErrorHandler_403_ReturnsForbiddenCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusForbidden, "forbidden"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Code != "FORBIDDEN" {
		t.Errorf("code = %q, want FORBIDDEN", body.Code)
	}
}

func TestErrorHandler_UnknownHTTPStatus_ReturnsErrorCode(t *testing.T) {
	rec := doErrorRequest(t, echo.NewHTTPError(http.StatusTeapot, "i am a teapot"))

	var body ormserver.ErrorResponse
	json.Unmarshal(rec.Body.Bytes(), &body) //nolint:errcheck
	if body.Code != "ERROR" {
		t.Errorf("code = %q, want ERROR for unknown status", body.Code)
	}
}

func TestErrorHandler_PlainError_Returns500WithInternalCode(t *testing.T) {
	e := ormserver.NewEcho(nil)
	e.GET("/boom", func(c echo.Context) error {
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
	if body.Code != "INTERNAL_ERROR" {
		t.Errorf("code = %q, want INTERNAL_ERROR", body.Code)
	}
	if body.Error != "internal server error" {
		t.Errorf("error = %q, want %q", body.Error, "internal server error")
	}
}

type plainError struct{ msg string }

func (e *plainError) Error() string { return e.msg }

// ── AuthRateLimiter ───────────────────────────────────────────────────────────

func TestAuthRateLimiter_BlocksAfterBurst(t *testing.T) {
	e := echo.New()
	e.GET("/x", func(c echo.Context) error { return c.NoContent(http.StatusOK) },
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
