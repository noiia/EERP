package website

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// downStore fails every read and write, as an unreachable database does.
type downStore struct{}

func (downStore) Get(context.Context, uuid.UUID, uuid.UUID, string) (string, bool, error) {
	return "", false, errors.New("down")
}
func (downStore) Set(context.Context, uuid.UUID, uuid.UUID, string, string) error {
	return errors.New("down")
}

func sfCall(t *testing.T, h echo.HandlerFunc, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec
}

// Settings → Website's file editors: read what's stored (defaults when nothing
// is), refuse bodies they can't use, and surface a store failure as a 500.
func TestSiteFilesAdmin(t *testing.T) {
	h := NewSiteFilesHandler(memStore{}, uuid.New())
	h.now = func() time.Time { return sfNow }

	t.Run("nothing stored reads as empty settings", func(t *testing.T) {
		for name, get := range map[string]echo.HandlerFunc{"legal": h.GetLegal, "security": h.GetSecurity, "robots": h.GetRobots} {
			if rec := sfCall(t, get, http.MethodGet, "/", ""); rec.Code != http.StatusOK {
				t.Errorf("%s: %d", name, rec.Code)
			}
		}
		if rec := sfCall(t, h.GetSecurity, http.MethodGet, "/", ""); !strings.Contains(rec.Body.String(), `"contacts":[]`) {
			t.Errorf("security contacts must be an empty list, got %s", rec.Body.String())
		}
	})

	refusals := []struct {
		name string
		put  echo.HandlerFunc
		body string
	}{
		{"legal: malformed", h.PutLegal, `{`},
		{"security: malformed", h.PutSecurity, `{`},
		{"security: invalid", h.PutSecurity, `{"contacts":["javascript:alert(1)"],"expires":"2027-01-01T00:00:00Z"}`},
		{"robots: malformed", h.PutRobots, `{`},
		{"robots: too long", h.PutRobots, `{"extra":"` + strings.Repeat("a", maxLongField+1) + `"}`},
	}
	for _, tc := range refusals {
		t.Run(tc.name, func(t *testing.T) {
			if rec := sfCall(t, tc.put, http.MethodPut, "/", tc.body); rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
		})
	}

	t.Run("robots lines round-trip, CRLF normalised", func(t *testing.T) {
		if rec := sfCall(t, h.PutRobots, http.MethodPut, "/", `{"extra":"Disallow: /a\r\nDisallow: /b"}`); rec.Code != http.StatusNoContent {
			t.Fatalf("put: %d", rec.Code)
		}
	})

	t.Run("a store that can't be reached", func(t *testing.T) {
		down := NewSiteFilesHandler(downStore{}, uuid.New())
		down.now = func() time.Time { return sfNow }
		calls := map[string]*httptest.ResponseRecorder{
			"get legal":    sfCall(t, down.GetLegal, http.MethodGet, "/", ""),
			"put robots":   sfCall(t, down.PutRobots, http.MethodPut, "/", `{"extra":"x"}`),
			"public legal": sfCall(t, down.PublicLegal, http.MethodGet, "/", ""),
			"security.txt": sfCall(t, down.PublicSecurityTxt, http.MethodGet, "/", ""),
			"robots.txt":   sfCall(t, down.PublicRobotsTxt, http.MethodGet, "/?host=x", ""),
		}
		for name, rec := range calls {
			if rec.Code != http.StatusInternalServerError {
				t.Errorf("%s: %d, want 500", name, rec.Code)
			}
		}
	})
}
