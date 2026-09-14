package presence

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
)

// Handler serves the presence endpoints, all mounted behind a cookie-or-Bearer
// auth middleware (core/internal/middleware.JWTOrCookieMiddleware — a native
// WebSocket handshake can't carry a custom Authorization header, but the
// browser sends the session cookie automatically on same-origin requests; see
// ADR-019) + the standard permission middleware, both deriving
// presence:presence:read|write from ONE route ("/api/v1/presence") — the
// WebSocket upgrade and the plain snapshot read share that single GET path,
// dispatched on the Upgrade header, precisely so they resolve to the SAME
// permission instead of needing separate grants.
type Handler struct {
	repo *Repository
	hub  *Hub
}

// NewHandler wires the presence Handler.
func NewHandler(repo *Repository, hub *Hub) *Handler {
	return &Handler{repo: repo, hub: hub}
}

var upgrader = websocket.Upgrader{
	// Same-origin only in practice (the gateway is the only path to this
	// route) — CheckOrigin defaults to same-origin-or-no-Origin-header, which
	// is what we want; no CORS wildcarding for a stateful socket.
}

type presenceEntry struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
}

// Get handles GET /api/v1/presence — a WebSocket upgrade request opens the
// live socket (serveWS); anything else returns the plain tenant snapshot.
func (h *Handler) Get(c echo.Context) error {
	if websocket.IsWebSocketUpgrade(c.Request()) {
		return h.serveWS(c)
	}
	return h.snapshot(c)
}

// snapshot returns every presence row for the caller's tenant, resolved
// through Effective. A user who has never connected/set a status simply
// isn't in the list — the frontend defaults an unknown user to offline.
func (h *Handler) snapshot(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	rows, err := h.repo.ListByTenant(c.Request().Context(), identity.TenantID)
	if err != nil {
		return fmt.Errorf("presence: snapshot: %w", err)
	}
	out := make([]presenceEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, presenceEntry{
			UserID: r.UserID.String(),
			Status: Effective(r.ManualStatus, r.Connected, r.LastSeen),
		})
	}
	return c.JSON(http.StatusOK, out)
}

// SetStatus handles PUT /api/v1/presence — body {"status": "busy"|"do_not_disturb"|""}.
// "" (or omitted) clears the override, returning the user to automatic
// online/absent/offline tracking.
func (h *Handler) SetStatus(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var req struct {
		Status string `json:"status"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if !ValidManualStatus(req.Status) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", `status must be "busy", "do_not_disturb", or "".`)
	}

	row, err := h.repo.SetManualStatus(c.Request().Context(), identity.TenantID, identity.UserID, req.Status)
	if err != nil {
		return fmt.Errorf("presence: set status: %w", err)
	}
	status := Effective(row.ManualStatus, row.Connected, row.LastSeen)
	h.broadcastUpdate(identity.TenantID, identity.UserID, status)
	return c.JSON(http.StatusOK, presenceEntry{UserID: identity.UserID.String(), Status: status})
}

// serveWS upgrades the connection, marks the caller connected, sends them the
// full tenant snapshot, broadcasts their own new status, then pumps until the
// socket closes — at which point it marks them disconnected (only if this was
// their last open tab/session — see Hub.unregister) and broadcasts that too.
func (h *Handler) serveWS(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	conn, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return fmt.Errorf("presence: ws upgrade: %w", err)
	}

	row, err := h.repo.SetConnected(ctx, identity.TenantID, identity.UserID, true)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("presence: connect: %w", err)
	}

	cl := &client{conn: conn, tenantID: identity.TenantID, userID: identity.UserID, send: make(chan []byte, 8)}
	h.hub.register(cl)

	if snap, err := h.repo.ListByTenant(ctx, identity.TenantID); err == nil {
		entries := make([]presenceEntry, 0, len(snap))
		for _, r := range snap {
			entries = append(entries, presenceEntry{UserID: r.UserID.String(), Status: Effective(r.ManualStatus, r.Connected, r.LastSeen)})
		}
		if payload, err := json.Marshal(struct {
			Type  string          `json:"type"`
			Users []presenceEntry `json:"users"`
		}{Type: "snapshot", Users: entries}); err == nil {
			select {
			case cl.send <- payload:
			default:
			}
		}
	}

	h.broadcastUpdate(identity.TenantID, identity.UserID, Effective(row.ManualStatus, row.Connected, row.LastSeen))

	done := make(chan struct{})
	go writePump(cl, done)
	readPump(cl) // blocks until the connection closes
	close(done)

	if lastConnection := h.hub.unregister(cl); lastConnection {
		if row, err := h.repo.SetConnected(context.Background(), identity.TenantID, identity.UserID, false); err == nil {
			h.broadcastUpdate(identity.TenantID, identity.UserID, Effective(row.ManualStatus, row.Connected, row.LastSeen))
		}
	}
	return nil
}

func (h *Handler) broadcastUpdate(tenantID, userID uuid.UUID, status string) {
	if payload := updatePayload(userID, status); payload != nil {
		h.hub.Broadcast(tenantID, payload)
	}
}

// readPump discards any client-sent frames (the protocol is server->client
// only) and returns when the connection closes — its sole job is detecting
// disconnect and keeping the read deadline serviced by pong frames.
func readPump(cl *client) {
	const pongWait = pingInterval*2 + 5*time.Second
	_ = cl.conn.SetReadDeadline(time.Now().Add(pongWait))
	cl.conn.SetPongHandler(func(string) error {
		return cl.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		if _, _, err := cl.conn.ReadMessage(); err != nil {
			return
		}
	}
}

// writePump is the ONLY goroutine allowed to write to cl.conn (gorilla's
// concurrency contract), draining cl.send and pinging on pingInterval.
func writePump(cl *client, done <-chan struct{}) {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = cl.conn.Close()
	}()
	for {
		select {
		case <-done:
			return
		case payload := <-cl.send:
			if err := cl.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			if err := cl.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func errorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
