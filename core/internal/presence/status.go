package presence

import "time"

// absentAfter is how long a disconnected user shows as "absent" before
// flipping to "offline" — the sweeper (sweeper.go) polls for this boundary.
const absentAfter = 30 * time.Minute

// The five colors the frontend ever renders. ManualStatus only ever stores
// StatusBusy/StatusDoNotDisturb (or nil) — StatusAbsent/StatusOffline are
// never manually selectable, only ever the result of Effective below.
const (
	StatusOnline       = "online"
	StatusAbsent       = "absent"
	StatusOffline      = "offline"
	StatusBusy         = "busy"
	StatusDoNotDisturb = "do_not_disturb"
)

// ValidManualStatus reports whether s is a settable manual override
// ("" clears it back to automatic tracking).
func ValidManualStatus(s string) bool {
	return s == "" || s == StatusBusy || s == StatusDoNotDisturb
}

// Effective resolves the one status the frontend renders, from the stored
// row. A manual busy/do_not_disturb override always wins, even while
// disconnected (mirrors Teams: setting yourself Busy doesn't get silently
// cleared by a flaky connection). With no override, status follows the
// connection: online while connected, else absent for up to absentAfter,
// then offline.
func Effective(manual *string, connected bool, lastSeen time.Time) string {
	if manual != nil && (*manual == StatusBusy || *manual == StatusDoNotDisturb) {
		return *manual
	}
	if connected {
		return StatusOnline
	}
	if time.Since(lastSeen) >= absentAfter {
		return StatusOffline
	}
	return StatusAbsent
}
