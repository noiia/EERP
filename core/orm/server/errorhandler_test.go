package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

// A 4xx carrying a wrapped cause answers with its public message only and
// logs the cause server-side.
func TestErrorHandler_LogsWrappedCause(t *testing.T) {
	core, logs := observer.New(zap.InfoLevel)
	e := echo.New()
	e.HTTPErrorHandler = newErrorHandler(zap.New(core))
	e.GET("/t", func(*echo.Context) error {
		return echo.NewHTTPError(http.StatusBadRequest, "bad value").Wrap(errors.New("secret_constraint"))
	})
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/t", nil))
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), "secret_constraint") {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body)
	}
	if all := logs.All(); len(all) != 1 || all[0].ContextMap()["error"] != "secret_constraint" {
		t.Fatalf("cause not logged: %v", logs.All())
	}
}

// Fast successes log at Debug; failures and slow requests reach Info.
func TestZapMiddleware_Levels(t *testing.T) {
	core, logs := observer.New(zap.DebugLevel)
	e := echo.New()
	e.Use(zapMiddleware(zap.New(core)))
	e.GET("/ok", func(c *echo.Context) error { return c.NoContent(http.StatusOK) })
	e.GET("/missing", func(*echo.Context) error { return echo.ErrNotFound })
	for _, path := range []string{"/ok", "/missing"} {
		e.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	all := logs.All()
	if len(all) != 2 || all[0].Level != zap.DebugLevel || all[1].Level != zap.InfoLevel || all[1].ContextMap()["status"] != int64(http.StatusNotFound) {
		t.Fatalf("levels: %+v", all)
	}
}
