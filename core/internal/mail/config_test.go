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
		// Go's PLAIN auth never sends a password in clear to a remote server: refuse at boot, not at send time.
		{"password without tls to a remote relay", with(func(c *types.Config) { c.SMTPHost = "ssl0.ovh.net"; c.SMTPTLS = "none"; c.SMTPPassword = "p" }), true},
		{"password without tls to a local catcher", with(func(c *types.Config) { c.SMTPHost = "127.0.0.1"; c.SMTPTLS = "none"; c.SMTPPassword = "p" }), false},
		{"password with starttls", with(func(c *types.Config) { c.SMTPHost = "ssl0.ovh.net"; c.SMTPTLS = "starttls"; c.SMTPPassword = "p" }), false},
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

// A mailbox provider logs in with the sender's own address: with only a
// password set, the login is smtp_from's address.
func TestNewSMTPTransport_LoginDefaultsToTheSender(t *testing.T) {
	tr := NewSMTPTransport(&types.Config{SMTPHost: "h", SMTPFrom: "Shop <no-reply@shop.example>", SMTPPassword: "secret"})
	if tr.user != "no-reply@shop.example" {
		t.Errorf("user = %q, want the from address", tr.user)
	}
	if tr := NewSMTPTransport(&types.Config{SMTPHost: "h", SMTPFrom: "a@b.io", SMTPUser: "login", SMTPPassword: "p"}); tr.user != "login" {
		t.Errorf("an explicit smtp_user was overridden: %q", tr.user)
	}
	if tr := NewSMTPTransport(&types.Config{SMTPHost: "h", SMTPFrom: "a@b.io"}); tr.user != "" {
		t.Errorf("no password: user = %q, want none (no AUTH)", tr.user)
	}
}

func TestConfigWarnings(t *testing.T) {
	for name, tt := range map[string]struct {
		cfg  types.Config
		want bool
	}{
		"remote relay without credentials":  {types.Config{SMTPHost: "ssl0.ovh.net", SMTPFrom: "a@b.io"}, true},
		"remote relay with a password":      {types.Config{SMTPHost: "ssl0.ovh.net", SMTPFrom: "a@b.io", SMTPPassword: "p"}, false},
		"local catcher without credentials": {types.Config{SMTPHost: "mailpit", SMTPFrom: "a@b.io"}, false},
		"no smtp":                           {types.Config{}, false},
	} {
		if got := len(ConfigWarnings(&tt.cfg)) > 0; got != tt.want {
			t.Errorf("%s: warnings %v, want %v", name, ConfigWarnings(&tt.cfg), tt.want)
		}
	}
}
