package event

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/labstack/echo/v5"
)

var (
	errEvent    = errors.New("invalid event")
	timePattern = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// intRanges are the inclusive bounds of the event's integer settings.
var intRanges = map[string][2]int{
	"slot_minutes":          {5, 480},
	"buffer_minutes":        {0, 240},
	"booking_horizon_days":  {1, 365},
	"min_notice_hours":      {0, 720},
	"slot_capacity":         {1, 1000},
	"max_seats_per_booking": {1, 100},
}

// nullableInts are the integer settings stored as a nullable column: the
// form sends null for them when empty (or hidden, e.g. on a sessions event).
var nullableInts = map[string]bool{"buffer_minutes": true}

func checkInt(body map[string]any, key string, lo, hi int) error {
	raw, ok := body[key]
	if !ok || (raw == nil && nullableInts[key]) {
		return nil
	}
	n, isNum := raw.(float64) // JSON numbers
	if !isNum || n != float64(int(n)) || int(n) < lo || int(n) > hi {
		return fmt.Errorf("%w: %s must be an integer between %d and %d", errEvent, key, lo, hi)
	}
	return nil
}

// validateEvent checks the keys present in body (a PUT may send a subset).
func validateEvent(body map[string]any) error {
	if raw, ok := body["kind"]; ok && raw != KindSessions && raw != KindAppointment {
		return fmt.Errorf("%w: kind must be %q or %q", errEvent, KindSessions, KindAppointment)
	}
	if raw, ok := body["timezone"]; ok {
		tz, isStr := raw.(string)
		if !isStr || tz == "" {
			return fmt.Errorf("%w: timezone must be an IANA name", errEvent)
		}
		if _, err := time.LoadLocation(tz); err != nil {
			return fmt.Errorf("%w: unknown timezone %q", errEvent, tz)
		}
	}
	for key, r := range intRanges {
		if err := checkInt(body, key, r[0], r[1]); err != nil {
			return err
		}
	}
	return nil
}

// validateAvailability checks the keys present in body.
func validateAvailability(body map[string]any) error {
	if err := checkInt(body, "weekday", 0, 6); err != nil {
		return err
	}
	for _, key := range []string{"from_time", "to_time"} {
		if raw, ok := body[key]; ok {
			if s, isStr := raw.(string); !isStr || !timePattern.MatchString(s) {
				return fmt.Errorf("%w: %s must be HH:MM", errEvent, key)
			}
		}
	}
	from, _ := body["from_time"].(string)
	to, _ := body["to_time"].(string)
	if from != "" && to != "" && from >= to { // zero-padded HH:MM sorts lexically
		return fmt.Errorf("%w: from_time must be before to_time", errEvent)
	}
	return nil
}

// validateSession checks the keys present in body. The stored counterpart of
// a partial update (only ends_at, say) isn't checked here; seats_taken <=
// capacity is a DB constraint (module.go) so it also holds under concurrency.
func validateSession(body map[string]any) error {
	if err := checkInt(body, "capacity", 1, 100000); err != nil {
		return err
	}
	var at [2]time.Time
	for i, key := range []string{"starts_at", "ends_at"} {
		raw, ok := body[key]
		if !ok || raw == nil { // null: left to the generic handler
			continue
		}
		s, _ := raw.(string)
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return fmt.Errorf("%w: %s must be an RFC 3339 time", errEvent, key)
		}
		at[i] = t
	}
	if !at[0].IsZero() && !at[1].IsZero() && !at[1].After(at[0]) {
		return fmt.Errorf("%w: ends_at must be after starts_at", errEvent)
	}
	return nil
}

// eventDefaults fill a POSTed event's omitted required columns.
var eventDefaults = map[string]any{
	"kind": KindSessions, "timezone": "Europe/Paris", "slot_minutes": 30, "slot_capacity": 1,
	"booking_horizon_days": 60, "min_notice_hours": 2, "max_seats_per_booking": 10,
}

// validateBody reads and validates the JSON body, lets mutate adjust it, then
// restores it for the generic handler to bind.
func validateBody(validate func(map[string]any) error, mutate func(*http.Request, map[string]any)) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			raw, err := io.ReadAll(c.Request().Body)
			if err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
			}
			var body map[string]any
			if err := json.Unmarshal(raw, &body); err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
			}
			if body == nil { // a literal JSON null
				body = map[string]any{}
				raw = []byte("{}")
			}
			if err := validate(body); err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, err.Error())
			}
			if mutate != nil {
				mutate(c.Request(), body)
				raw, _ = json.Marshal(body)
			}
			c.Request().Body = io.NopCloser(bytes.NewReader(raw))
			return next(c)
		}
	}
}

// ValidateEventBody runs in front of the GENERIC event Create/Update; on POST
// it also defaults the omitted required settings.
var ValidateEventBody = validateBody(validateEvent, func(r *http.Request, body map[string]any) {
	if r.Method != http.MethodPost {
		return
	}
	for k, v := range eventDefaults {
		if _, ok := body[k]; !ok {
			body[k] = v
		}
	}
})

// ValidateSessionBody runs in front of the GENERIC event_session Create/Update.
var ValidateSessionBody = validateBody(validateSession, nil)

// ValidateAvailabilityBody runs in front of the GENERIC event_availability Create/Update.
var ValidateAvailabilityBody = validateBody(validateAvailability, nil)
