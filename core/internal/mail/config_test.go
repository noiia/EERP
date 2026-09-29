package mail

import (
	"testing"

	"core/internal/types"
)

func TestValidateConfig(t *testing.T) {
	ok := types.Config{SMTPHost: "h", SMTPFrom: "EERP <no-reply@x.io>"}
	with := func(mod func(*types.Config)) *types.Config { c := ok; mod(&c); return &c }
	tests := []struct {
		name    string
		cfg     *types.Config
		wantErr bool
	}{
		{"no smtp host skips checks", &types.Config{SMTPTLS: "typo"}, false},
		{"valid", &ok, false},
		{"implicit", with(func(c *types.Config) { c.SMTPTLS = "implicit" }), false},
		{"tls typo", with(func(c *types.Config) { c.SMTPTLS = "starttsl" }), true},
		{"empty from", with(func(c *types.Config) { c.SMTPFrom = "" }), true},
		{"garbage from", with(func(c *types.Config) { c.SMTPFrom = "not an address" }), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidateConfig(tt.cfg); (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestNewSMTPTransport_DefaultPort(t *testing.T) {
	for tlsMode, want := range map[string]int{"": 587, "starttls": 587, "none": 587, "implicit": 465} {
		if got := NewSMTPTransport(&types.Config{SMTPHost: "h", SMTPTLS: tlsMode}).port; got != want {
			t.Errorf("tls %q: port %d, want %d", tlsMode, got, want)
		}
	}
	if got := NewSMTPTransport(&types.Config{SMTPHost: "h", SMTPTLS: "implicit", SMTPPort: 2465}).port; got != 2465 {
		t.Errorf("explicit port overridden: %d", got)
	}
}
