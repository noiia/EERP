package presence

import (
	"testing"
	"time"
)

func TestEffective(t *testing.T) {
	busy := StatusBusy
	dnd := StatusDoNotDisturb

	cases := []struct {
		name      string
		manual    *string
		connected bool
		lastSeen  time.Time
		want      string
	}{
		{"connected, no override -> online", nil, true, time.Now(), StatusOnline},
		{"just disconnected -> absent", nil, false, time.Now(), StatusAbsent},
		{"disconnected 29m -> still absent", nil, false, time.Now().Add(-29 * time.Minute), StatusAbsent},
		{"disconnected exactly 30m -> offline", nil, false, time.Now().Add(-absentAfter), StatusOffline},
		{"disconnected past 30m -> offline", nil, false, time.Now().Add(-31 * time.Minute), StatusOffline},
		{"busy overrides connected", &busy, true, time.Now(), StatusBusy},
		{"busy survives disconnect", &busy, false, time.Now().Add(-time.Hour), StatusBusy},
		{"do_not_disturb overrides connected", &dnd, true, time.Now(), StatusDoNotDisturb},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Effective(tc.manual, tc.connected, tc.lastSeen); got != tc.want {
				t.Errorf("Effective() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestValidManualStatus(t *testing.T) {
	for _, s := range []string{"", StatusBusy, StatusDoNotDisturb} {
		if !ValidManualStatus(s) {
			t.Errorf("ValidManualStatus(%q) = false, want true", s)
		}
	}
	for _, s := range []string{StatusOnline, StatusAbsent, StatusOffline, "bogus"} {
		if ValidManualStatus(s) {
			t.Errorf("ValidManualStatus(%q) = true, want false", s)
		}
	}
}
