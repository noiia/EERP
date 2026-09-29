package event

import (
	"strings"
	"testing"
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
