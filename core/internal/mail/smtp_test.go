package mail

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"core/internal/types"
)

// fakeSMTP speaks just enough SMTP; returns its port and a func yielding the
// commands seen plus the DATA payload once the session ends.
func fakeSMTP(t *testing.T, startTLS bool, quitReply string) (int, func() (cmds []string, data string)) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	done := make(chan struct{})
	var cmds []string
	var data strings.Builder
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		r := bufio.NewReader(conn)
		w := func(s string) { _, _ = conn.Write([]byte(s + "\r\n")) }
		w("220 fake")
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			cmds = append(cmds, strings.ToUpper(fields[0]))
			switch cmds[len(cmds)-1] {
			case "EHLO":
				if startTLS {
					w("250-fake")
					w("250 STARTTLS")
				} else {
					w("250 fake")
				}
			case "MAIL", "RCPT":
				w("250 ok")
			case "DATA":
				w("354 go")
				for {
					l, err := r.ReadString('\n')
					if err != nil || l == ".\r\n" {
						break
					}
					data.WriteString(l)
				}
				w("250 queued")
			case "QUIT":
				w(quitReply)
				return
			default:
				w("500 what")
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, func() ([]string, string) {
		_ = ln.Close()
		<-done
		return cmds, data.String()
	}
}

func TestSMTPTransportSend(t *testing.T) {
	tests := []struct {
		name, mode, quit string
		startTLS         bool
		wantErr          bool
		wantMail         bool
	}{
		{"none delivers", "none", "221 bye", false, false, true},
		{"starttls without server support refuses", "starttls", "221 bye", false, true, false},
		{"quit failure after DATA is not an error", "none", "421 nope", false, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			port, result := fakeSMTP(t, tc.startTLS, tc.quit)
			tr := NewSMTPTransport(&types.Config{SMTPHost: "127.0.0.1", SMTPPort: port, SMTPFrom: "EERP <no-reply@eerp.io>", SMTPTLS: tc.mode})
			err := tr.Send(context.Background(), Outbox{ToAddress: "vi@x.io", Subject: "Café confirmé", BodyText: "hi"})
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			cmds, data := result()
			gotMail := false
			for _, c := range cmds {
				gotMail = gotMail || c == "MAIL"
			}
			if gotMail != tc.wantMail {
				t.Errorf("MAIL seen = %v, want %v (cmds %v)", gotMail, tc.wantMail, cmds)
			}
			if tc.wantMail && !strings.Contains(data, "=?utf-8?q?Caf=C3=A9_confirm=C3=A9?=") {
				t.Errorf("DATA lacks Q-encoded subject:\n%s", data)
			}
		})
	}
}

// scriptedSMTP is fakeSMTP with per-command replies (default "250 ok") and a
// chosen EHLO extension list — to drive each refusal Send reports.
func scriptedSMTP(t *testing.T, extensions []string, replies map[string]string) (int, func() []string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	done := make(chan struct{})
	var cmds []string
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		r := bufio.NewReader(conn)
		w := func(s string) { _, _ = conn.Write([]byte(s + "\r\n")) }
		w("220 fake")
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			// A blank line has no command — and the implicit-TLS case sends a
			// binary ClientHello, whose random bytes can hold whitespace-only lines.
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			cmd := strings.ToUpper(fields[0])
			cmds = append(cmds, cmd)
			if reply, ok := replies[cmd]; ok {
				w(reply)
				if cmd == "QUIT" || strings.HasPrefix(reply, "5") && cmd == "DATA" {
					return
				}
				continue
			}
			switch cmd {
			case "EHLO":
				for i, ext := range extensions {
					sep := "-"
					if i == len(extensions)-1 {
						sep = " "
					}
					w("250" + sep + ext)
				}
				if len(extensions) == 0 {
					w("250 fake")
				}
			case "DATA":
				w("354 go")
				for {
					l, err := r.ReadString('\n')
					if err != nil || l == ".\r\n" {
						break
					}
				}
				w("250 queued")
			case "AUTH":
				w("235 authenticated")
			case "QUIT":
				w("221 bye")
				return
			default:
				w("250 ok")
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, func() []string {
		_ = ln.Close()
		<-done
		return cmds
	}
}

// Every refusal along the way is an error naming its step; credentials go
// through AUTH PLAIN; an attachment makes the message multipart.
func TestSMTPTransportSend_Failures(t *testing.T) {
	msg := Outbox{ToAddress: "vi@x.io", Subject: "Invite", BodyText: "hi", BodyHTML: "<p>hi</p>",
		Attachments: `[{"filename":"invite.ics","content_type":"text/calendar","data":"QkVHSU46VkNBTEVOREFS"}]`}
	tests := []struct {
		name     string
		password string
		ext      []string
		replies  map[string]string
		wantErr  string
		wantCmds []string
		tlsMode  string
	}{
		{name: "MAIL refused without credentials hints at them", replies: map[string]string{"MAIL": "530 auth required"}, wantErr: "no credentials are configured"},
		{name: "MAIL refused with credentials", password: "pw", ext: []string{"fake", "AUTH PLAIN"}, replies: map[string]string{"MAIL": "550 nope"}, wantErr: "smtp MAIL FROM"},
		{name: "AUTH refused", password: "pw", ext: []string{"fake", "AUTH PLAIN"}, replies: map[string]string{"AUTH": "535 bad credentials"}, wantErr: "smtp auth"},
		{name: "RCPT refused", replies: map[string]string{"RCPT": "550 no such user"}, wantErr: "smtp RCPT TO"},
		{name: "DATA refused", replies: map[string]string{"DATA": "554 no"}, wantErr: "smtp DATA"},
		{name: "authenticated multipart delivery", password: "pw", ext: []string{"fake", "AUTH PLAIN"}, wantCmds: []string{"AUTH", "MAIL", "RCPT", "DATA"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			port, result := scriptedSMTP(t, tc.ext, tc.replies)
			mode := tc.tlsMode
			if mode == "" {
				mode = "none"
			}
			tr := NewSMTPTransport(&types.Config{SMTPHost: "127.0.0.1", SMTPPort: port, SMTPFrom: "EERP <no-reply@eerp.io>",
				SMTPPassword: tc.password, SMTPTLS: mode})
			err := tr.Send(context.Background(), msg)
			cmds := result()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("send: %v", err)
				}
				for _, want := range tc.wantCmds {
					if !strings.Contains(strings.Join(cmds, " "), want) {
						t.Errorf("commands %v lack %s", cmds, want)
					}
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("err = %v, want it to mention %q", err, tc.wantErr)
			}
		})
	}

	t.Run("implicit TLS against a plain server fails the handshake", func(t *testing.T) {
		port, result := scriptedSMTP(t, nil, nil)
		tr := NewSMTPTransport(&types.Config{SMTPHost: "127.0.0.1", SMTPPort: port, SMTPFrom: "a@b.io", SMTPTLS: "implicit"})
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := tr.Send(ctx, msg); err == nil {
			t.Error("want a TLS error")
		}
		result()
	})

	t.Run("nobody listening is a dial error", func(t *testing.T) {
		ln, _ := net.Listen("tcp", "127.0.0.1:0")
		port := ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
		tr := NewSMTPTransport(&types.Config{SMTPHost: "127.0.0.1", SMTPPort: port, SMTPFrom: "a@b.io", SMTPTLS: "none"})
		if err := tr.Send(context.Background(), msg); err == nil || !strings.Contains(err.Error(), "smtp dial") {
			t.Errorf("err = %v, want a dial error", err)
		}
	})

	t.Run("default ports follow the TLS mode", func(t *testing.T) {
		if p := NewSMTPTransport(&types.Config{SMTPHost: "h"}).port; p != 587 {
			t.Errorf("starttls default port = %d, want 587", p)
		}
		if p := NewSMTPTransport(&types.Config{SMTPHost: "h", SMTPTLS: "implicit"}).port; p != 465 {
			t.Errorf("implicit default port = %d, want 465", p)
		}
	})
}
