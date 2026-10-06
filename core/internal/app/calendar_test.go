package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCalendarFeeds(t *testing.T) {
	c := buildSiteApp(t)
	anon := &client{t: t, h: c.h}
	ctx := context.Background()
	t.Cleanup(func() { _, _ = c.do(http.MethodDelete, "/api/v1/me/event_feed", nil) })

	code, body := c.do(http.MethodPost, "/api/v1/event", map[string]any{"name": "cal-" + uuid.NewString()[:8], "kind": "sessions", "published": true})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create event: %d %s", code, body)
	}
	eventID := decode(t, body)["id"].(string)
	t.Cleanup(func() {
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event_session WHERE event_id = $1`, eventID)
		_, _ = c.a.db.DB.Exec(ctx, `DELETE FROM event WHERE id = $1`, eventID)
	})
	start := time.Now().Add(72 * time.Hour).UTC()
	code, body = c.do(http.MethodPost, "/api/v1/event_session", map[string]any{"event_id": eventID,
		"starts_at": start.Format(time.RFC3339), "ends_at": start.Add(time.Hour).Format(time.RFC3339), "capacity": 4})
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("create session: %d %s", code, body)
	}
	uid := "UID:session-" + decode(t, body)["id"].(string) + "@eerp"

	code, body = anon.do(http.MethodGet, "/api/v1/public/event/"+eventID+"/calendar.ics", nil)
	if code != http.StatusOK || !strings.Contains(string(body), uid) {
		t.Errorf("public calendar: %d\n%s", code, body)
	}

	code, body = c.do(http.MethodPost, "/api/v1/me/event_feed", nil)
	if code != http.StatusCreated {
		t.Fatalf("create feed: %d %s", code, body)
	}
	first := decode(t, body)["path"].(string)
	code, body = anon.do(http.MethodGet, first, nil)
	if code != http.StatusOK || !strings.Contains(string(body), uid) || !strings.Contains(string(body), "(0/4)") {
		t.Errorf("staff feed: %d\n%s", code, body)
	}
	_, body = c.do(http.MethodGet, "/api/v1/me/event_feed", nil)
	if decode(t, body)["enabled"] != true {
		t.Errorf("feed status = %s, want enabled", body)
	}
	_, body = c.do(http.MethodPost, "/api/v1/me/event_feed", nil)
	second := decode(t, body)["path"].(string)
	if code, _ := anon.do(http.MethodGet, first, nil); code != http.StatusNotFound {
		t.Errorf("replaced link = %d, want 404", code)
	}
	if code, _ := c.do(http.MethodDelete, "/api/v1/me/event_feed", nil); code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	if code, _ := anon.do(http.MethodGet, second, nil); code != http.StatusNotFound {
		t.Errorf("revoked link = %d, want 404", code)
	}
}
