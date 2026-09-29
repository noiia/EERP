package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/orm/access"

	"github.com/labstack/echo/v5"
)

func TestPublicScopeMiddleware(t *testing.T) {
	published := func(_ context.Context, table string) (access.PublicScope, bool, error) {
		if table != "product" {
			return access.PublicScope{}, false, nil
		}
		return access.PublicScope{Columns: []string{"id", "name"}}, true, nil
	}
	tests := []struct {
		name, table, query string
		want               int
		wantScope          bool
	}{
		{"published table", "product", "", http.StatusOK, true},
		{"unpublished table is 404", "crm", "", http.StatusNotFound, false},
		{"aggregate refused", "product", "?aggregate=count", http.StatusBadRequest, false},
		{"page_size at cap allowed", "product", "?page_size=100", http.StatusOK, true},
		{"page_size over cap refused", "product", "?page_size=101", http.StatusBadRequest, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := echo.New()
			var sawScope bool
			e.GET("/x", func(c *echo.Context) error {
				_, sawScope = access.PublicScopeFromContext(c.Request().Context())
				return c.NoContent(http.StatusOK)
			}, PublicScopeMiddleware(tt.table, published))
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x"+tt.query, nil))
			if rec.Code != tt.want || sawScope != tt.wantScope {
				t.Errorf("code=%d scope=%v, want %d %v", rec.Code, sawScope, tt.want, tt.wantScope)
			}
		})
	}
}
