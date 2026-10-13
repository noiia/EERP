package presence

import (
	"testing"

	"github.com/google/uuid"
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
