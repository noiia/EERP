package event

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
)

func TestValidateEvent(t *testing.T) {
	tests := []struct {
		name    string
		body    map[string]any
		wantErr string
	}{
		{"sessions event", map[string]any{"name": "Workshop", "kind": "sessions"}, ""},
		{"appointment event", map[string]any{"name": "Visit", "kind": "appointment", "slot_minutes": 30.0, "timezone": "Europe/Paris"}, ""},
		{"unknown kind", map[string]any{"kind": "party"}, "kind"},
		{"bad timezone", map[string]any{"timezone": "Mars/Olympus"}, "timezone"},
		{"slot too short", map[string]any{"slot_minutes": 4.0}, "slot_minutes"},
		{"negative buffer", map[string]any{"buffer_minutes": -1.0}, "buffer_minutes"},
		{"horizon too long", map[string]any{"booking_horizon_days": 400.0}, "booking_horizon_days"},
		{"zero slot capacity", map[string]any{"slot_capacity": 0.0}, "slot_capacity"},
		{"max seats zero", map[string]any{"max_seats_per_booking": 0.0}, "max_seats_per_booking"},
		{"non-numeric slot", map[string]any{"slot_minutes": "30"}, "slot_minutes"},
		{"partial update without kind is fine", map[string]any{"name": "x"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEvent(tt.body)
			if (tt.wantErr == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), tt.wantErr)) {
				t.Fatalf("err = %v, want %q", err, tt.wantErr)
			}
		})
	}
}

func TestValidateAvailability(t *testing.T) {
	tests := []struct {
		name    string
		body    map[string]any
		wantErr bool
	}{
		{"valid", map[string]any{"weekday": 1.0, "from_time": "09:00", "to_time": "17:00"}, false},
		{"weekday out of range", map[string]any{"weekday": 7.0}, true},
		{"bad time", map[string]any{"from_time": "9h"}, true},
		{"from after to", map[string]any{"from_time": "18:00", "to_time": "09:00"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateAvailability(tt.body); (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestValidateSession(t *testing.T) {
	tests := []struct {
		name    string
		body    map[string]any
		wantErr bool
	}{
		{"valid", map[string]any{"starts_at": "2030-01-01T10:00:00Z", "ends_at": "2030-01-01T11:00:00Z", "capacity": 5.0}, false},
		{"partial update", map[string]any{"price": 3.0}, false},
		{"ends before starts", map[string]any{"starts_at": "2030-01-01T10:00:00Z", "ends_at": "2030-01-01T09:00:00Z"}, true},
		{"ends equals starts", map[string]any{"starts_at": "2030-01-01T10:00:00Z", "ends_at": "2030-01-01T10:00:00Z"}, true},
		{"unparseable time", map[string]any{"starts_at": "tomorrow"}, true},
		{"zero capacity", map[string]any{"capacity": 0.0}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateSession(tt.body); (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// A literal JSON null body must not panic the event defaults (Task 1 review).
func TestValidateEventBody_NullBody(t *testing.T) {
	e := echo.New()
	var got map[string]any
	e.POST("/e", func(c *echo.Context) error {
		return json.NewDecoder(c.Request().Body).Decode(&got)
	}, ValidateEventBody)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/e", strings.NewReader("null")))
	if rec.Code != http.StatusOK || got["kind"] != KindSessions {
		t.Fatalf("code=%d body=%v, want 200 with defaults", rec.Code, got)
	}
}
