package mail

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/textproto"
	"strings"
	"time"
)

// buildMessage renders o as an RFC 5322 message: a multipart/alternative of
// a text/plain part (always) and a text/html part (when BodyHTML is set),
// wrapped in multipart/mixed with base64 parts when o carries attachments.
// UTF-8 throughout — subject Q-encoded, bodies quoted-printable.
func buildMessage(from string, o Outbox, now time.Time) ([]byte, error) {
	var attachments []Attachment
	if o.Attachments != "" {
		if err := json.Unmarshal([]byte(o.Attachments), &attachments); err != nil {
			return nil, fmt.Errorf("mail: attachments: %w", err)
		}
	}
	// NewWriter writes nothing until CreatePart, so the headers written into buf
	// below come first; its random boundary is already fixed.
	var buf bytes.Buffer
	top := multipart.NewWriter(&buf)
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, err
	}
	domain := "eerp.local"
	if at := strings.LastIndex(from, "@"); at >= 0 {
		domain = strings.TrimSuffix(from[at+1:], ">")
	}
	ctype := "multipart/alternative"
	if len(attachments) > 0 {
		ctype = "multipart/mixed"
	}
	hdr := []string{
		"From: " + from,
		"To: " + o.ToAddress,
		"Subject: " + mime.QEncoding.Encode("utf-8", o.Subject),
		"Date: " + now.Format(time.RFC1123Z),
		"Message-ID: <" + hex.EncodeToString(idBytes) + "@" + domain + ">",
		"MIME-Version: 1.0",
		"Content-Type: " + ctype + "; boundary=" + top.Boundary(),
	}
	buf.WriteString(strings.Join(hdr, "\r\n") + "\r\n\r\n")
	alt := top
	if len(attachments) > 0 {
		var inner bytes.Buffer
		alt = multipart.NewWriter(&inner)
		if err := writeBodies(alt, o); err != nil {
			return nil, err
		}
		part, err := top.CreatePart(textproto.MIMEHeader{"Content-Type": {"multipart/alternative; boundary=" + alt.Boundary()}})
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(inner.Bytes()); err != nil {
			return nil, err
		}
		for _, a := range attachments {
			part, err := top.CreatePart(textproto.MIMEHeader{
				"Content-Type":              {a.ContentType},
				"Content-Transfer-Encoding": {"base64"},
				"Content-Disposition":       {mime.FormatMediaType("attachment", map[string]string{"filename": a.Filename})},
			})
			if err != nil {
				return nil, err
			}
			enc := base64.NewEncoder(base64.StdEncoding, &lineBreaker{w: part})
			if _, err := enc.Write(a.Data); err != nil {
				return nil, err
			}
			if err := enc.Close(); err != nil {
				return nil, err
			}
		}
	} else if err := writeBodies(alt, o); err != nil {
		return nil, err
	}
	if err := top.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeBodies writes the text and HTML parts into w and closes it.
func writeBodies(w *multipart.Writer, o Outbox) error {
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
			return err
		}
		qp := quotedprintable.NewWriter(part)
		if _, err := qp.Write([]byte(p.body)); err != nil {
			return err
		}
		if err := qp.Close(); err != nil {
			return err
		}
	}
	return w.Close()
}

// lineBreaker wraps base64 output at 76 characters (RFC 2045).
type lineBreaker struct {
	w   io.Writer
	col int
}

func (l *lineBreaker) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		chunk := min(76-l.col, len(p))
		if _, err := l.w.Write(p[:chunk]); err != nil {
			return n, err
		}
		n += chunk
		p = p[chunk:]
		if l.col += chunk; l.col == 76 {
			if _, err := l.w.Write([]byte("\r\n")); err != nil {
				return n, err
			}
			l.col = 0
		}
	}
	return n, nil
}
