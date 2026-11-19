package event

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/chatter"
	"core/internal/testdb"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// evCall runs one event handler as an anonymous visitor (signedIn false) or a
// signed-in one, with an optional :id and JSON body.
func evCall(t *testing.T, h echo.HandlerFunc, id, body string, signedIn bool) int {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	tenant := uuid.New()
	ctx := access.WithTenant(req.Context(), tenant)
	if signedIn {
		ctx = auth.SetIdentity(ctx, auth.Identity{UserID: uuid.New(), TenantID: tenant})
	}
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(echo.PathValues{{Name: "id", Value: id}})
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec.Code
}

// The booking endpoints' guards: unknown ids, malformed bodies, anonymous
// callers on account routes, and a database that can't be reached.
func TestEventHandlers_RefusalsAndDatabaseDown(t *testing.T) {
	db := testdb.Closed(t).DB
	h := NewHandler(db, NewService(db, chatter.NewRepository(db), ""))
	// What the generic session update would answer: the guard passes it through.
	refused := func(c *echo.Context) error { return c.NoContent(http.StatusBadRequest) }
	id := uuid.NewString()

	cases := []struct {
		name     string
		call     echo.HandlerFunc
		id       string
		body     string
		signedIn bool
		want     int
	}{
		{"sessions: bad id", h.PublicSessions, "nope", "", false, http.StatusNotFound},
		{"sessions: database down", h.PublicSessions, id, "", false, http.StatusInternalServerError},
		{"slots: bad id", h.PublicSlots, "nope", "", false, http.StatusNotFound},
		{"cancel by token: malformed", h.CancelByToken, "", `{`, false, http.StatusBadRequest},
		{"claim by token: malformed", h.ClaimByToken, "", `{`, false, http.StatusBadRequest},
		{"my bookings: anonymous", h.MyBookings, "", "", false, http.StatusUnauthorized},
		{"my bookings: database down", h.MyBookings, "", "", true, http.StatusInternalServerError},
		{"cancel mine: anonymous", h.CancelMine, id, "", false, http.StatusUnauthorized},
		{"cancel mine: bad id", h.CancelMine, "nope", "", true, http.StatusNotFound},
		{"staff update: bad id", h.StaffUpdate(refused), "nope", `{}`, true, http.StatusBadRequest},
		{"staff update: malformed", h.StaffUpdate(refused), id, `{`, true, http.StatusBadRequest},
		{"staff update: database down", h.StaffUpdate(refused), id, `{"name":"A"}`, true, http.StatusInternalServerError},
		{"delete session: bad id", h.DeleteSession, "nope", "", true, http.StatusBadRequest},
		{"delete session: database down", h.DeleteSession, id, "", true, http.StatusInternalServerError},
		{"session update: bad id", h.GuardSessionUpdate(refused), "nope", `{}`, true, http.StatusBadRequest},
		{"session update: malformed goes to the generic handler", h.GuardSessionUpdate(refused), id, `{`, true, http.StatusBadRequest},
		{"session update: no event_id goes to the generic handler", h.GuardSessionUpdate(refused), id, `{"capacity":3}`, true, http.StatusBadRequest},
		{"session update: database down", h.GuardSessionUpdate(refused), id, `{"event_id":"` + id + `"}`, true, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code := evCall(t, tc.call, tc.id, tc.body, tc.signedIn); code != tc.want {
				t.Fatalf("status = %d, want %d", code, tc.want)
			}
		})
	}
}
