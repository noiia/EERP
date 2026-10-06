package mail

import (
	"bytes"
	"encoding/base64"
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

func TestBuildMessage_WithAttachment(t *testing.T) {
	ics := "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
	o := Outbox{ToAddress: "c@d.io", Subject: "s", BodyText: "t", BodyHTML: "<p>t</p>",
		Attachments: `[{"filename":"invite.ics","content_type":"text/calendar; method=REQUEST; charset=utf-8","data":"` +
			base64.StdEncoding.EncodeToString([]byte(ics)) + `"}]`}
	raw, err := buildMessage("a@b.io", o, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, _ := mail.ReadMessage(bytes.NewReader(raw))
	ct, params, _ := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if ct != "multipart/mixed" {
		t.Fatalf("content-type = %s, want multipart/mixed", ct)
	}
	parts := multipart.NewReader(msg.Body, params["boundary"])
	first, _ := parts.NextPart()
	if inner, _, _ := mime.ParseMediaType(first.Header.Get("Content-Type")); inner != "multipart/alternative" {
		t.Errorf("first part = %s, want the text/html alternative", inner)
	}
	_, _ = io.ReadAll(first)
	att, err := parts.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(att.Header.Get("Content-Type"), "text/calendar") || att.FileName() != "invite.ics" {
		t.Errorf("attachment headers = %v", att.Header)
	}
	body, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, att))
	if string(body) != ics {
		t.Errorf("attachment body = %q", body)
	}
}
