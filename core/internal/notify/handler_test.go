package notify_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/notify"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func call(t *testing.T, h echo.HandlerFunc, method, body string, id auth.Identity) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, "/api/v1/notifications", nil)
	} else {
		req = httptest.NewRequest(method, "/api/v1/notifications/read", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(auth.SetIdentity(req.Context(), id))
	rec := httptest.NewRecorder()
	if err := h(e.NewContext(req, rec)); err != nil {
		e.HTTPErrorHandler(e.NewContext(req, rec), err)
	}
	return rec
}

func TestHandler_TwoUsers(t *testing.T) {
	f := setup(t)
	pub := &fakePub{}
	svc := notify.NewService(f.repo, pub)
	h := notify.NewHandler(svc)
	ctx := context.Background()
	alicePersonal, _ := svc.Personal(ctx, f.tenant, f.alice, notify.Message{Category: "dev_seed", Title: "Mine", Link: "/settings/developer"})
	alice := auth.Identity{UserID: f.alice, TenantID: f.tenant}
	bob := auth.Identity{UserID: f.bob, TenantID: f.tenant}

	t.Run("bob's feed never contains alice's notification", func(t *testing.T) {
		rec := call(t, h.List, http.MethodGet, "", bob)
		if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), alicePersonal.ID.String()) {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	})
	t.Run("no user ids are ever serialized", func(t *testing.T) {
		body := call(t, h.List, http.MethodGet, "", alice).Body.String()
		if !strings.Contains(body, alicePersonal.ID.String()) || strings.Contains(body, f.alice.String()) || strings.Contains(body, "user_id") {
			t.Fatalf("feed = %s", body)
		}
	})
	t.Run("bob cannot mark it read, and learns nothing", func(t *testing.T) {
		rec := call(t, h.MarkRead, http.MethodPost, `{"ids":["`+alicePersonal.ID.String()+`"]}`, bob)
		var body struct {
			IDs []uuid.UUID `json:"ids"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusOK || len(body.IDs) != 0 {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	})
	t.Run("alice reads it; her other tabs are told", func(t *testing.T) {
		before := len(pub.all())
		rec := call(t, h.MarkRead, http.MethodPost, `{"all":true}`, alice)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		frames := pub.all()[before:]
		if len(frames) != 1 || frames[0].users[0] != f.alice || frames[0].frame["type"] != "notification_read" {
			t.Fatalf("frames = %+v", frames)
		}
		var feed struct {
			Unread int `json:"unread"`
		}
		_ = json.Unmarshal(call(t, h.List, http.MethodGet, "", alice).Body.Bytes(), &feed)
		if feed.Unread != 0 {
			t.Errorf("unread = %d", feed.Unread)
		}
	})
	t.Run("malformed body is a 400", func(t *testing.T) {
		if rec := call(t, h.MarkRead, http.MethodPost, `{"ids":["not-a-uuid"]}`, alice); rec.Code != http.StatusBadRequest {
			t.Errorf("code = %d", rec.Code)
		}
	})
}
