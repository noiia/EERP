package website

import (
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func TestWorkflowLayout_Validate(t *testing.T) {
	many := map[string]Point{}
	for i := 0; i <= maxWorkflowNodes; i++ {
		many[strings.Repeat("x", 1+i%5)+string(rune('a'+i%26))+uuid.NewString()] = Point{}
	}
	cases := []struct {
		name    string
		l       WorkflowLayout
		wantErr bool
	}{
		{"empty", WorkflowLayout{}, false},
		{"typical", WorkflowLayout{Positions: map[string]Point{"page:": {X: 0, Y: 0}, "sys:login": {X: -280.5, Y: 120}}}, false},
		{"empty id", WorkflowLayout{Positions: map[string]Point{"": {}}}, true},
		{"id too long", WorkflowLayout{Positions: map[string]Point{"page:" + strings.Repeat("a", maxWorkflowNodeID): {}}}, true},
		{"coordinate too far", WorkflowLayout{Positions: map[string]Point{"page:a": {X: 2e6}}}, true},
		{"NaN", WorkflowLayout{Positions: map[string]Point{"page:a": {Y: math.NaN()}}}, true},
		{"too many", WorkflowLayout{Positions: many}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.l.validate(); (err != nil) != tc.wantErr {
				t.Errorf("validate() = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestWorkflowLayoutHandler(t *testing.T) {
	h := NewWorkflowLayoutHandler(memStore{})
	tenant := uuid.New()
	call := func(fn echo.HandlerFunc, method, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{TenantID: tenant}))
		rec := httptest.NewRecorder()
		if err := fn(echo.New().NewContext(req, rec)); err != nil {
			if he, ok := err.(*echo.HTTPError); ok {
				rec.Code = he.Code
			} else {
				t.Fatal(err)
			}
		}
		return rec
	}

	t.Run("nothing saved reads as no positions", func(t *testing.T) {
		rec := call(h.Get, http.MethodGet, "")
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"positions":{}}` {
			t.Errorf("GET = %d %q", rec.Code, rec.Body.String())
		}
	})
	t.Run("saved positions read back", func(t *testing.T) {
		if rec := call(h.Put, http.MethodPut, `{"positions":{"page:about":{"x":10,"y":20}}}`); rec.Code != http.StatusNoContent {
			t.Fatalf("PUT = %d %q", rec.Code, rec.Body.String())
		}
		rec := call(h.Get, http.MethodGet, "")
		if !strings.Contains(rec.Body.String(), `"page:about":{"x":10,"y":20}`) {
			t.Errorf("GET = %q", rec.Body.String())
		}
	})
	t.Run("invalid is a 400", func(t *testing.T) {
		if rec := call(h.Put, http.MethodPut, `{"positions":{"page:a":{"x":5000000,"y":0}}}`); rec.Code != http.StatusBadRequest {
			t.Errorf("PUT = %d", rec.Code)
		}
		if rec := call(h.Put, http.MethodPut, `not json`); rec.Code != http.StatusBadRequest {
			t.Errorf("malformed PUT = %d", rec.Code)
		}
	})
}
