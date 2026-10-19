package presence

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

func TestHub_SendToUsers_OnlyTargets(t *testing.T) {
	h := NewHub()
	tenant, other := uuid.New(), uuid.New()
	alice, bob, carol := uuid.New(), uuid.New(), uuid.New()
	mk := func(tn, u uuid.UUID) *client {
		c := &client{tenantID: tn, userID: u, send: make(chan []byte, 4)}
		h.register(c)
		return c
	}
	aliceTab1, aliceTab2, bobTab := mk(tenant, alice), mk(tenant, alice), mk(tenant, bob)
	carolElsewhere := mk(other, carol)

	h.SendToUsers(tenant, []uuid.UUID{alice, carol}, []byte("x"))

	tests := []struct {
		name string
		c    *client
		want int
	}{
		{"alice tab 1", aliceTab1, 1},
		{"alice tab 2", aliceTab2, 1},
		{"bob not targeted", bobTab, 0},
		{"carol targeted but in another tenant", carolElsewhere, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := len(tc.c.send); got != tc.want {
				t.Errorf("frames = %d, want %d", got, tc.want)
			}
		})
	}
}

// CloseAll drops every live socket (a database switch), whoever owns it; the
// peer sees its connection end.
func TestHub_CloseAll(t *testing.T) {
	h := NewHub()
	serverConns := make(chan *websocket.Conn, 2)
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		serverConns <- conn
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	var peers []*websocket.Conn
	for i := 0; i < 2; i++ {
		peer, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = peer.Close() }()
		peers = append(peers, peer)
		h.register(&client{conn: <-serverConns, tenantID: uuid.New(), userID: uuid.New(), send: make(chan []byte, 1)})
	}

	h.CloseAll()
	for i, peer := range peers {
		_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, _, err := peer.ReadMessage(); err == nil {
			t.Errorf("peer %d still connected after CloseAll", i)
		}
	}
	h.CloseAll() // nothing left: a no-op
}
