// Package presence tracks live user presence — online/absent/offline/busy/
// do_not_disturb — over a WebSocket, plus a REST snapshot for the initial
// page load. One row per user, off the generic CRUD surface (mirrors
// internal/chatter/internal/notebook's shape): the dedicated handler here is
// the only HTTP path to it.
//
// See docs/adr/ADR-019-user-presence-websocket.md for the auth model (a
// narrowly-scoped cookie fallback, not a new ticket flow) and the
// single-Go-instance caveat.
package presence

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// UserPresence is the live/last-known presence state for one user. Connected
// and LastSeen are updated synchronously on every WebSocket connect/
// disconnect; ManualStatus is the user's own override (busy/do_not_disturb),
// nil meaning "no override — derive from Connected/LastSeen" (see status.go's
// Effective). absent/offline are never stored as a status string — they're
// always recomputed from Connected/LastSeen at read time.
type UserPresence struct {
	model.BaseModel
	UserID       uuid.UUID `db:"user_id,index"`
	ManualStatus *string   `db:"manual_status"`
	Connected    bool      `db:"connected"`
	LastSeen     time.Time `db:"last_seen"`
}
