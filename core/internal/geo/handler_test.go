package geo

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v5"
)

func TestDistance_MalformedRefIs400(t *testing.T) {
	c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, "/api/v1/geo/distance?from=x&to=y", nil), httptest.NewRecorder())
	err := NewHandler(nil).Distance(c)
	if he, ok := err.(*echo.HTTPError); !ok || he.Code != http.StatusBadRequest {
		t.Fatalf("err = %v, want 400", err)
	}
}
