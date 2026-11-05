package event

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/testdb"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type stubRoles struct{ err error }

func (s stubRoles) FindRoleNames(context.Context, uuid.UUID) ([]string, error) {
	return []string{"staff"}, s.err
}

type stubPerms struct {
	ok  bool
	err error
}

func (s stubPerms) Has(context.Context, []string, string) (bool, error) { return s.ok, s.err }

func feedCall(t *testing.T, h echo.HandlerFunc, method, file string) int {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, "/", strings.NewReader(""))
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if file != "" {
		c.SetPathValues(echo.PathValues{{Name: "file", Value: file}})
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec.Code
}

// The staff feed's guards: who may create one, a malformed link, and a
// database that can't be reached — a 403/404/500, never a feed.
func TestFeedHandler_Guards(t *testing.T) {
	down := testdb.Closed(t).DB
	boom := errors.New("down")
	token := strings.Repeat("a", 64) + ".ics"

	cases := []struct {
		name string
		h    *FeedHandler
		call func(h *FeedHandler) echo.HandlerFunc
		verb string
		file string
		want int
	}{
		{"create without the permission", NewFeedHandler(down, stubRoles{}, stubPerms{ok: false}), func(h *FeedHandler) echo.HandlerFunc { return h.Create }, http.MethodPost, "", http.StatusForbidden},
		{"create when roles can't be read", NewFeedHandler(down, stubRoles{err: boom}, stubPerms{ok: true}), func(h *FeedHandler) echo.HandlerFunc { return h.Create }, http.MethodPost, "", http.StatusInternalServerError},
		{"create when the permission check fails", NewFeedHandler(down, stubRoles{}, stubPerms{err: boom}), func(h *FeedHandler) echo.HandlerFunc { return h.Create }, http.MethodPost, "", http.StatusInternalServerError},
		{"create on a database down", NewFeedHandler(down, stubRoles{}, stubPerms{ok: true}), func(h *FeedHandler) echo.HandlerFunc { return h.Create }, http.MethodPost, "", http.StatusInternalServerError},
		{"read mine on a database down", NewFeedHandler(down, stubRoles{}, stubPerms{ok: true}), func(h *FeedHandler) echo.HandlerFunc { return h.GetMine }, http.MethodGet, "", http.StatusInternalServerError},
		{"delete on a database down", NewFeedHandler(down, stubRoles{}, stubPerms{ok: true}), func(h *FeedHandler) echo.HandlerFunc { return h.Delete }, http.MethodDelete, "", http.StatusInternalServerError},
		{"a link of the wrong length", NewFeedHandler(down, stubRoles{}, stubPerms{ok: true}), func(h *FeedHandler) echo.HandlerFunc { return h.Feed }, http.MethodGet, "short.ics", http.StatusNotFound},
		{"a feed on a database down", NewFeedHandler(down, stubRoles{}, stubPerms{ok: true}), func(h *FeedHandler) echo.HandlerFunc { return h.Feed }, http.MethodGet, token, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code := feedCall(t, tc.call(tc.h), tc.verb, tc.file); code != tc.want {
				t.Fatalf("status = %d, want %d", code, tc.want)
			}
		})
	}
}
