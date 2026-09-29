package mail

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func TestBuildMessage(t *testing.T) {
	o := Outbox{ToAddress: "vi@x.io", Subject: "Réservation confirmée — Café", BodyText: "Merci, à bientôt ☕", BodyHTML: "<p>Merci</p>"}
	raw, err := buildMessage("EERP <no-reply@eerp.io>", o, time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("not a valid RFC 5322 message: %v\n%s", err, raw)
	}
	subj, _ := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if subj != o.Subject {
		t.Errorf("subject = %q, want %q", subj, o.Subject)
	}
	if msg.Header.Get("To") != "vi@x.io" || msg.Header.Get("Message-Id") == "" {
		t.Errorf("headers = %v", msg.Header)
	}
	_, params, _ := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	parts := multipart.NewReader(msg.Body, params["boundary"])
	var bodies []string
	for {
		p, err := parts.NextPart() // decodes quoted-printable transparently
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(p)
		bodies = append(bodies, string(b))
	}
	if len(bodies) != 2 || bodies[0] != o.BodyText || !strings.Contains(bodies[1], "<p>Merci</p>") {
		t.Errorf("bodies = %q", bodies)
	}
}

func TestBuildMessage_TextOnly(t *testing.T) {
	raw, err := buildMessage("a@b.io", Outbox{ToAddress: "c@d.io", Subject: "s", BodyText: "t"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, _ := mail.ReadMessage(bytes.NewReader(raw))
	if ct, _, _ := mime.ParseMediaType(msg.Header.Get("Content-Type")); ct != "multipart/alternative" {
		t.Errorf("content-type = %s", ct)
	}
}
