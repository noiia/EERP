package mail

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/textproto"
	"strings"
	"time"
)

// buildMessage renders o as a multipart/alternative RFC 5322 message: a
// text/plain part always, a text/html part when BodyHTML is set. UTF-8
// throughout — subject Q-encoded, bodies quoted-printable.
func buildMessage(from string, o Outbox, now time.Time) ([]byte, error) {
	// NewWriter writes nothing until CreatePart, so the headers written into buf
	// below come first; its random boundary is already fixed.
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, err
	}
	domain := "eerp.local"
	if at := strings.LastIndex(from, "@"); at >= 0 {
		domain = strings.TrimSuffix(from[at+1:], ">")
	}
	hdr := []string{
		"From: " + from,
		"To: " + o.ToAddress,
		"Subject: " + mime.QEncoding.Encode("utf-8", o.Subject),
		"Date: " + now.Format(time.RFC1123Z),
		"Message-ID: <" + hex.EncodeToString(idBytes) + "@" + domain + ">",
		"MIME-Version: 1.0",
		"Content-Type: multipart/alternative; boundary=" + w.Boundary(),
	}
	buf.WriteString(strings.Join(hdr, "\r\n") + "\r\n\r\n")
	for _, p := range []struct{ ctype, body string }{
		{"text/plain; charset=utf-8", o.BodyText},
		{"text/html; charset=utf-8", o.BodyHTML},
	} {
		if p.body == "" {
			continue
		}
		part, err := w.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {p.ctype},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, err
		}
		qp := quotedprintable.NewWriter(part)
		if _, err := qp.Write([]byte(p.body)); err != nil {
			return nil, err
		}
		if err := qp.Close(); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
