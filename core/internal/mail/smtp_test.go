package mail

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"

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
			line = strings.TrimRight(line, "\r\n")
			cmds = append(cmds, strings.ToUpper(strings.Fields(line + " ")[0]))
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
