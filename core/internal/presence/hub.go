package presence

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// pingInterval keeps the connection alive through the gateway's
// proxy_read_timeout (infra/nginx/nginx.conf's presence/ws location) —
// browsers answer a WebSocket ping frame with a pong automatically, no
// client JS needed.
const pingInterval = 25 * time.Second

// client is one open WebSocket connection. send is buffered so a slow reader
// never blocks Hub.Broadcast; writePump is the only goroutine that writes to
// conn, per gorilla/websocket's concurrency contract (one writer at a time).
type client struct {
	conn     *websocket.Conn
	tenantID uuid.UUID
	userID   uuid.UUID
	send     chan []byte
}

// Hub is the in-memory registry of live presence connections for this Go
// process. Single-instance only — see ADR-019 for the NATS upgrade path if
// core-back ever scales to more than one replica (compose.yml runs one
// today, unlike pdf-service's explicit worker pool).
type Hub struct {
	mu       sync.Mutex
	byTenant map[uuid.UUID]map[*client]struct{}
	byUser   map[uuid.UUID]map[*client]struct{}
}

// NewHub constructs an empty Hub.
func NewHub() *Hub {
	return &Hub{
		byTenant: make(map[uuid.UUID]map[*client]struct{}),
		byUser:   make(map[uuid.UUID]map[*client]struct{}),
	}
}

func (h *Hub) register(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.byTenant[c.tenantID] == nil {
		h.byTenant[c.tenantID] = make(map[*client]struct{})
	}
	h.byTenant[c.tenantID][c] = struct{}{}
	if h.byUser[c.userID] == nil {
		h.byUser[c.userID] = make(map[*client]struct{})
	}
	h.byUser[c.userID][c] = struct{}{}
}

// unregister removes c and reports whether that was the user's LAST open
// connection (across every tab/session) — the caller only marks the user
// disconnected in that case, so closing one of several tabs doesn't flip a
// still-active user to absent.
func (h *Hub) unregister(c *client) (lastConnection bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if tenantSet := h.byTenant[c.tenantID]; tenantSet != nil {
		delete(tenantSet, c)
		if len(tenantSet) == 0 {
			delete(h.byTenant, c.tenantID)
		}
	}
	userSet := h.byUser[c.userID]
	if userSet == nil {
		return true
	}
	delete(userSet, c)
	if len(userSet) == 0 {
		delete(h.byUser, c.userID)
		return true
	}
	return false
}

// Broadcast fans payload out to every connection in tenantID. Non-blocking
// per client — a client whose send buffer is full is dropped (its next ping
// failure will clean it up) rather than stalling every other broadcast.
func (h *Hub) Broadcast(tenantID uuid.UUID, payload []byte) {
	h.mu.Lock()
	targets := make([]*client, 0, len(h.byTenant[tenantID]))
	for c := range h.byTenant[tenantID] {
		targets = append(targets, c)
	}
	h.mu.Unlock()

	for _, c := range targets {
		select {
		case c.send <- payload:
		default:
		}
	}
}

// updatePayload builds the one WS wire message shape every status push uses
// (Handler.broadcastUpdate and SweepAbsentToOffline) — {"type":"update", ...}.
func updatePayload(userID uuid.UUID, status string) []byte {
	payload, err := json.Marshal(struct {
		Type   string `json:"type"`
		UserID string `json:"user_id"`
		Status string `json:"status"`
	}{Type: "update", UserID: userID.String(), Status: status})
	if err != nil {
		return nil
	}
	return payload
}
