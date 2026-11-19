# Mail Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give EERP transactional email: callers enqueue a message inside their own DB transaction, and a background sender delivers it over SMTP with retries; Mailpit catches everything in dev.

**Architecture:** New `core/internal/mail` package + `core/modules/mail` Go module (off the generic CRUD surface). `mail.Enqueue(ctx, ex orm.Executor, msg)` inserts a `mail_outbox` row through whatever executor the caller holds (a `*orm.Tx` makes the email commit or roll back with the business write). `mail.Sender.Run` ticks every 30 s, claims due rows with `FOR UPDATE SKIP LOCKED`, sends them through a `Transport` (SMTP via `net/smtp` in production, a fake in tests), and records success or exponential backoff. A small admin API lists rows and re-queues failures.

**Tech Stack:** Go stdlib (`net/smtp`, `crypto/tls`, `mime`, `mime/multipart`, `net/textproto`), pgx via `core/orm`, Echo v5; Mailpit (`axllent/mailpit`) in `compose.yml`.

**Spec:** `docs/superpowers/specs/2026-09-29-website-3-mail-outbox-design.md`

## Global Constraints

- Prefix every command with `rtk`; search with `rg`.
- Backend tests: `rtk make run-back-tests BACKTESTPATH=./<pkg>/... ARGS="-run X"` from the repo root (starts the Docker DB; Go is off PATH).
- `depguard`: no `fmt.Print*`/`log` — `common.Logger` (zap). `fmt.Errorf` is fine.
- DB tests: `testdb.Open(t)` + `testdb.MigrateModules(t, app, "mail")`; every row under a fresh `uuid.New()` tenant; clean up only those rows. The sender's claim takes a tenant filter so a test never touches other tenants' pending mail.
- Retry policy (verbatim from the spec): `attempts+1`, `next_attempt_at = now() + 2^attempts minutes`, `failed` after **5** attempts, `last_error` kept.
- Tick: **30 s**; batch: **20** rows.
- Config keys: `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `smtp_from`, `smtp_tls` (`starttls` | `implicit` | `none`). Empty `smtp_host` ⇒ sender not started, rows stay `pending`.
- Admin routes: `GET /api/v1/mail_outbox`, `POST /api/v1/mail_outbox/:id/retry` → permissions `mail_outbox:mail_outbox:read|write` (route-derived).
- Commits: `<type>(scope): <description>` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, on `dev`.

## Review Focus

1. **Header injection** — a subject or recipient containing `\r\n` must never add headers: `Enqueue` rejects CR/LF in `To`/`Subject`, and the subject is Q-encoded (Task 1 + Task 2 tests).
2. **Non-ASCII subjects/bodies** (`Réservation confirmée — Café`) arrive intact: Q-encoded subject, `quoted-printable` UTF-8 parts (Task 2 test).
3. **Two processes ticking at once** never send the same row twice (`SKIP LOCKED`, Task 3 concurrency test).
4. **SMTP down for hours** — rows back off and end `failed` after 5 attempts instead of hammering the relay every 30 s; `retry` re-queues them (Task 3 + Task 4 tests).
5. **Sender crash mid-batch** — a row is only marked `sent` after a successful send, inside the claim transaction; a crash rolls the claim back and the row is retried (at-least-once; documented, Task 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `core/internal/mail/models.go` | `Outbox` row, status constants, `Message` |
| `core/internal/mail/enqueue.go` | `Enqueue` — validated insert through a caller's executor |
| `core/internal/mail/mime.go` | build an RFC 5322 multipart/alternative message |
| `core/internal/mail/smtp.go` | `Transport` interface, `SMTPTransport` |
| `core/internal/mail/sender.go` | claim / send / backoff loop |
| `core/internal/mail/handler.go` | admin list + retry |
| `core/modules/mail/module.go` | registration (excluded) + index |
| `core/modules/all/all.go` | blank import |
| `core/internal/types/config.go` | `smtp_*` fields |
| `core/internal/app/app.go` | routes + `Run` ticker |
| `compose.yml`, `compose.prod.yml`, `eerp-config*.example.json` | Mailpit + config |
| `CLAUDE.md` | `internal/mail/` entry, config keys |

---

### Task 1: Outbox table and Enqueue

**Files:**
- Create: `core/internal/mail/models.go`, `core/internal/mail/enqueue.go`, `core/modules/mail/module.go`
- Modify: `core/modules/all/all.go`
- Test: `core/internal/mail/enqueue_test.go`

**Interfaces:**
- Produces: `mail.Message{TenantID uuid.UUID; To, Subject, Text, HTML string}`; `mail.Enqueue(ctx context.Context, ex orm.Executor, m Message) error`; `mail.ErrInvalidMessage`; `mail.Outbox` (table `mail_outbox`); status constants `StatusPending`, `StatusSent`, `StatusFailed`; module name `"mail"`.

- [ ] **Step 1: Write the failing test**

```go
package mail

import (
	"context"
	"errors"
	"testing"

	"core/internal/testdb"
	_ "core/modules/mail"
	"core/orm"

	"github.com/google/uuid"
)

func setup(t *testing.T) (*orm.App, uuid.UUID) {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "mail")
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(context.Background(), `DELETE FROM mail_outbox WHERE tenant_id = $1`, tenant)
	})
	return app, tenant
}

func countPending(t *testing.T, app *orm.App, tenant uuid.UUID) int {
	t.Helper()
	var n int
	if err := app.DB.QueryRow(context.Background(),
		`SELECT count(*) FROM mail_outbox WHERE tenant_id = $1 AND status = 'pending'`, tenant).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestEnqueue(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	ok := Message{TenantID: tenant, To: "a@b.io", Subject: "Hello", Text: "hi"}

	t.Run("commits with the caller's transaction", func(t *testing.T) {
		if err := orm.Transact(ctx, app.DB, func(tx *orm.Tx) error { return Enqueue(ctx, tx, ok) }); err != nil {
			t.Fatal(err)
		}
		if n := countPending(t, app, tenant); n != 1 {
			t.Fatalf("pending = %d, want 1", n)
		}
	})

	t.Run("rolls back with the caller's transaction", func(t *testing.T) {
		boom := errors.New("business write failed")
		_ = orm.Transact(ctx, app.DB, func(tx *orm.Tx) error {
			if err := Enqueue(ctx, tx, ok); err != nil {
				return err
			}
			return boom
		})
		if n := countPending(t, app, tenant); n != 1 {
			t.Fatalf("pending = %d, want still 1", n)
		}
	})

	invalid := []struct {
		name string
		m    Message
	}{
		{"no tenant", Message{To: "a@b.io", Subject: "s", Text: "t"}},
		{"bad address", Message{TenantID: tenant, To: "nope", Subject: "s", Text: "t"}},
		{"CRLF in subject", Message{TenantID: tenant, To: "a@b.io", Subject: "s\r\nBcc: x@y.io", Text: "t"}},
		{"CRLF in recipient", Message{TenantID: tenant, To: "a@b.io\r\nBcc: x@y.io", Subject: "s", Text: "t"}},
		{"no body", Message{TenantID: tenant, To: "a@b.io", Subject: "s"}},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			if err := Enqueue(ctx, app.DB, tt.m); !errors.Is(err, ErrInvalidMessage) {
				t.Errorf("err = %v, want ErrInvalidMessage", err)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/mail/... ARGS="-run TestEnqueue"`
Expected: FAIL — package `core/modules/mail` not found.

- [ ] **Step 3: Implement**

`core/internal/mail/models.go`:

```go
// Package mail is EERP's transactional email: callers enqueue a message in
// their own transaction (outbox pattern), a background Sender delivers it
// over SMTP with retries. See docs/superpowers/specs/2026-09-29-website-3-mail-outbox-design.md.
package mail

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

const (
	StatusPending = "pending"
	StatusSent    = "sent"
	StatusFailed  = "failed"
)

// Outbox is one queued email. Off the generic CRUD surface: rows hold
// addresses and bodies, reachable only through the admin handler.
type Outbox struct {
	model.BaseModel
	ToAddress     string     `db:"to_address"`
	Subject       string     `db:"subject"`
	BodyText      string     `db:"body_text"`
	BodyHTML      string     `db:"body_html"`
	Status        string     `db:"status"`
	Attempts      int        `db:"attempts"`
	NextAttemptAt time.Time  `db:"next_attempt_at"`
	LastError     string     `db:"last_error"`
	SentAt        *time.Time `db:"sent_at"`
}

// Message is what a caller enqueues. Text is required (every client can show
// it); HTML is optional and sent as the preferred alternative.
type Message struct {
	TenantID uuid.UUID
	To       string
	Subject  string
	Text     string
	HTML     string
}
```

`core/internal/mail/enqueue.go`:

```go
package mail

import (
	"context"
	"errors"
	"fmt"
	"net/mail"
	"strings"

	"core/orm"

	"github.com/google/uuid"
)

// ErrInvalidMessage rejects a message that could never be sent correctly.
var ErrInvalidMessage = errors.New("mail: invalid message")

// Enqueue queues m for delivery through ex — pass the caller's *orm.Tx so the
// email commits or rolls back with the business write (a plain *orm.DB works
// too). CR/LF in To/Subject is refused: they become headers.
func Enqueue(ctx context.Context, ex orm.Executor, m Message) error {
	if err := validate(m); err != nil {
		return err
	}
	_, err := ex.Exec(ctx, `
		INSERT INTO mail_outbox (tenant_id, to_address, subject, body_text, body_html, status, next_attempt_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())`,
		m.TenantID, m.To, m.Subject, m.Text, m.HTML, StatusPending)
	if err != nil {
		return fmt.Errorf("mail: enqueue: %w", err)
	}
	return nil
}

func validate(m Message) error {
	switch {
	case m.TenantID == uuid.Nil:
		return fmt.Errorf("%w: tenant required", ErrInvalidMessage)
	case strings.ContainsAny(m.To+m.Subject, "\r\n"):
		return fmt.Errorf("%w: line break in a header", ErrInvalidMessage)
	case m.Text == "":
		return fmt.Errorf("%w: text body required", ErrInvalidMessage)
	}
	if addr, err := mail.ParseAddress(m.To); err != nil || addr.Address != m.To {
		return fmt.Errorf("%w: bad recipient %q", ErrInvalidMessage, m.To)
	}
	return nil
}
```

(Check `orm.Executor`'s `Exec` signature in `core/orm/executor` — it's the same interface `captureExec` implements in the crud tests: `Exec(ctx, sql, args...) (pgconn.CommandTag, error)`.)

`core/modules/mail/module.go`:

```go
// Package mail registers the mail_outbox table. Import via core/modules/all.
package mail

import (
	"context"
	"fmt"

	"core/internal/mail"
	"core/internal/module"
	"core/orm"
)

func init() { module.RegisterGoModule(&mailModule{}) }

type mailModule struct{}

func (m *mailModule) Name() string { return "mail" }

// Register keeps mail_outbox OFF the generic CRUD surface (addresses and
// bodies); internal/mail's admin handler is the only HTTP path to it.
func (m *mailModule) Register() error {
	return orm.Register[mail.Outbox](orm.WithTableName("mail_outbox"), orm.WithExcluded())
}

// Migrate adds the index the sender's due-row claim scans.
func (m *mailModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE INDEX IF NOT EXISTS idx_mail_outbox_due
		ON mail_outbox (status, next_attempt_at)`); err != nil {
		return fmt.Errorf("mail: create due index: %w", err)
	}
	return nil
}
```

`all.go`: add `_ "core/modules/mail"` in alphabetical order.

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/mail core/modules/mail core/modules/all/all.go
rtk git commit -m "feat(mail): mail_outbox table and transactional Enqueue"
```

---

### Task 2: MIME builder and SMTP transport

**Files:**
- Create: `core/internal/mail/mime.go`, `core/internal/mail/smtp.go`
- Modify: `core/internal/types/config.go`
- Test: `core/internal/mail/mime_test.go`

**Interfaces:**
- Consumes: `Outbox` (Task 1).
- Produces: `buildMessage(from string, o Outbox, now time.Time) ([]byte, error)`; `type Transport interface { Send(ctx context.Context, o Outbox) error }`; `mail.NewSMTPTransport(cfg *types.Config) *SMTPTransport`; `mail.Configured(cfg *types.Config) bool`; config fields `SMTPHost`, `SMTPPort int`, `SMTPUser`, `SMTPPassword`, `SMTPFrom`, `SMTPTLS`.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/mail/... ARGS="-run TestBuildMessage"`
Expected: FAIL — `undefined: buildMessage`.

- [ ] **Step 3: Implement**

`config.go` (group near `RedisURL`):

```go
	// SMTP delivery for internal/mail. Empty SMTPHost disables the sender;
	// enqueued mail waits as pending until it's configured. SMTPTLS is
	// "starttls" (default), "implicit" (port 465) or "none" (dev Mailpit).
	SMTPHost     string `json:"smtp_host" needed:"false"`
	SMTPPort     int    `json:"smtp_port" needed:"false"`
	SMTPUser     string `json:"smtp_user" needed:"false"`
	SMTPPassword string `json:"smtp_password" needed:"false"`
	SMTPFrom     string `json:"smtp_from" needed:"false"`
	SMTPTLS      string `json:"smtp_tls" needed:"false"`
```

`mime.go`:

```go
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
```

`smtp.go`:

```go
package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"time"

	"core/internal/types"
)

// Transport delivers one outbox row. SMTPTransport in production; tests fake it.
type Transport interface {
	Send(ctx context.Context, o Outbox) error
}

// Configured reports whether SMTP delivery is set up.
func Configured(cfg *types.Config) bool { return cfg.SMTPHost != "" }

type SMTPTransport struct {
	host, user, password, from, tlsMode string
	port                                int
}

func NewSMTPTransport(cfg *types.Config) *SMTPTransport {
	port := cfg.SMTPPort
	if port == 0 {
		port = 587
	}
	mode := cfg.SMTPTLS
	if mode == "" {
		mode = "starttls"
	}
	return &SMTPTransport{host: cfg.SMTPHost, port: port, user: cfg.SMTPUser, password: cfg.SMTPPassword, from: cfg.SMTPFrom, tlsMode: mode}
}

// Send dials, optionally upgrades to TLS, authenticates when a user is set,
// and submits one message. One connection per message: volumes are small
// (confirmations), and it keeps failure handling per-row.
func (s *SMTPTransport) Send(ctx context.Context, o Outbox) error {
	raw, err := buildMessage(s.from, o, time.Now())
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(s.host, strconv.Itoa(s.port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	if s.tlsMode == "implicit" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	c, err := smtp.NewClient(conn, s.host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp hello: %w", err)
	}
	defer func() { _ = c.Close() }()
	if s.tlsMode == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("smtp: server does not offer STARTTLS (set smtp_tls to \"none\" only for a local catcher)")
		}
		if err := c.StartTLS(&tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if s.user != "" {
		if err := c.Auth(smtp.PlainAuth("", s.user, s.password, s.host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(envelopeAddress(s.from)); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := c.Rcpt(o.ToAddress); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(raw); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp end of data: %w", err)
	}
	return c.Quit()
}

// envelopeAddress strips a display name: "EERP <a@b.io>" → "a@b.io".
func envelopeAddress(from string) string {
	if a, err := mailAddress(from); err == nil {
		return a
	}
	return from
}
```

and in `enqueue.go` add the shared helper (reuses `net/mail` already imported there):

```go
func mailAddress(s string) (string, error) {
	a, err := mail.ParseAddress(s)
	if err != nil {
		return "", err
	}
	return a.Address, nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/mail core/internal/types/config.go
rtk git commit -m "feat(mail): MIME builder and SMTP transport (starttls/implicit/none)"
```

---

### Task 3: Sender — claim, send, back off

**Files:**
- Create: `core/internal/mail/sender.go`
- Test: `core/internal/mail/sender_test.go`

**Interfaces:**
- Consumes: `Transport`, `Outbox`, `Enqueue` (Tasks 1–2).
- Produces: `mail.NewSender(db *orm.DB, t Transport) *Sender`; `(*Sender).Run(ctx)` (30 s ticker); `(*Sender).Tick(ctx context.Context, tenant uuid.UUID) (sent, failed int, err error)` — `uuid.Nil` = every tenant (production), a specific tenant in tests.

- [ ] **Step 1: Write the failing test**

```go
package mail

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

type fakeTransport struct {
	mu    sync.Mutex
	sent  []string
	fail  bool
	calls atomic.Int32
}

func (f *fakeTransport) Send(_ context.Context, o Outbox) error {
	f.calls.Add(1)
	if f.fail {
		return errors.New("relay down")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, o.ToAddress)
	return nil
}

func rowState(t *testing.T, s *Sender, id uuid.UUID) (status string, attempts int, lastErr string) {
	t.Helper()
	if err := s.db.QueryRow(context.Background(),
		`SELECT status, attempts, last_error FROM mail_outbox WHERE id = $1`, id).Scan(&status, &attempts, &lastErr); err != nil {
		t.Fatal(err)
	}
	return
}

func onlyRow(t *testing.T, s *Sender, tenant uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := s.db.QueryRow(context.Background(), `SELECT id FROM mail_outbox WHERE tenant_id = $1`, tenant).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSender_SendsDueRows(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	for _, to := range []string{"a@x.io", "b@x.io"} {
		if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: to, Subject: "s", Text: "t"}); err != nil {
			t.Fatal(err)
		}
	}
	tr := &fakeTransport{}
	s := NewSender(app.DB, tr)
	if sent, failed, err := s.Tick(ctx, tenant); err != nil || sent != 2 || failed != 0 {
		t.Fatalf("tick = %d sent, %d failed, %v", sent, failed, err)
	}
	if n := countPending(t, app, tenant); n != 0 {
		t.Errorf("pending = %d, want 0", n)
	}
	// A second tick finds nothing due.
	if sent, _, _ := s.Tick(ctx, tenant); sent != 0 {
		t.Errorf("second tick sent %d, want 0", sent)
	}
}

func TestSender_BacksOffThenFails(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: "a@x.io", Subject: "s", Text: "t"}); err != nil {
		t.Fatal(err)
	}
	s := NewSender(app.DB, &fakeTransport{fail: true})
	id := onlyRow(t, s, tenant)

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		// Make the row due again without waiting out the backoff.
		if _, err := app.DB.Exec(ctx, `UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
		if _, failed, err := s.Tick(ctx, tenant); err != nil || failed != 1 {
			t.Fatalf("attempt %d: failed=%d err=%v", attempt, failed, err)
		}
		status, attempts, lastErr := rowState(t, s, id)
		wantStatus := StatusPending
		if attempt == maxAttempts {
			wantStatus = StatusFailed
		}
		if status != wantStatus || attempts != attempt || lastErr != "relay down" {
			t.Fatalf("attempt %d: status=%s attempts=%d lastErr=%q", attempt, status, attempts, lastErr)
		}
	}

	t.Run("backoff pushes next_attempt_at into the future", func(t *testing.T) {
		var future bool
		_ = app.DB.QueryRow(ctx, `SELECT next_attempt_at > now() FROM mail_outbox WHERE id = $1`, id).Scan(&future)
		if !future {
			t.Error("next_attempt_at not pushed forward")
		}
	})
}

// Review Focus #3: two concurrent ticks never send one row twice.
func TestSender_ConcurrentTicksSendOnce(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: "a@x.io", Subject: "s", Text: "t"}); err != nil {
			t.Fatal(err)
		}
	}
	tr := &fakeTransport{}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = NewSender(app.DB, tr).Tick(ctx, tenant)
		}()
	}
	wg.Wait()
	if got := tr.calls.Load(); got != 10 {
		t.Errorf("transport called %d times, want exactly 10", got)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/mail/... ARGS="-run TestSender"`
Expected: FAIL — `undefined: NewSender`.

- [ ] **Step 3: Implement** `sender.go`

```go
package mail

import (
	"context"
	"fmt"
	"time"

	"core/internal/common"
	"core/orm"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

const (
	tickInterval = 30 * time.Second
	batchSize    = 20
	maxAttempts  = 5
)

type Sender struct {
	db        *orm.DB
	transport Transport
}

func NewSender(db *orm.DB, t Transport) *Sender { return &Sender{db: db, transport: t} }

// Run ticks until ctx is canceled — start it in its own goroutine.
func (s *Sender) Run(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, _, err := s.Tick(ctx, uuid.Nil); err != nil {
				common.Logger.Warn("mail: tick", zap.Error(err))
			}
		}
	}
}

// Tick claims up to batchSize due rows (tenant uuid.Nil = all tenants), sends
// each and records the outcome — all inside one transaction, so the row locks
// (FOR UPDATE SKIP LOCKED) keep a concurrent Tick off them and a crash rolls
// the claim back. Delivery is therefore at-least-once: a crash after the relay
// accepted a message but before COMMIT re-sends it on the next tick.
func (s *Sender) Tick(ctx context.Context, tenant uuid.UUID) (sent, failed int, err error) {
	err = orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, to_address, subject, body_text, body_html, attempts
			FROM mail_outbox
			WHERE status = $1 AND next_attempt_at <= now() AND deleted_at IS NULL
			  AND ($2 = '00000000-0000-0000-0000-000000000000'::uuid OR tenant_id = $2)
			ORDER BY next_attempt_at
			LIMIT $3
			FOR UPDATE SKIP LOCKED`, StatusPending, tenant, batchSize)
		if err != nil {
			return err
		}
		var due []Outbox
		for rows.Next() {
			var o Outbox
			if err := rows.Scan(&o.ID, &o.ToAddress, &o.Subject, &o.BodyText, &o.BodyHTML, &o.Attempts); err != nil {
				rows.Close()
				return err
			}
			due = append(due, o)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, o := range due {
			if sendErr := s.transport.Send(ctx, o); sendErr != nil {
				failed++
				if err := markFailed(ctx, tx, o, sendErr); err != nil {
					return err
				}
				continue
			}
			sent++
			if _, err := tx.Exec(ctx,
				`UPDATE mail_outbox SET status = $2, sent_at = now(), attempts = attempts + 1, last_error = '', updated_at = now() WHERE id = $1`,
				o.ID, StatusSent); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, 0, fmt.Errorf("mail: tick: %w", err)
	}
	return sent, failed, nil
}

// markFailed records a failed attempt: exponential backoff (2^attempts
// minutes), then StatusFailed after maxAttempts.
func markFailed(ctx context.Context, tx *orm.Tx, o Outbox, sendErr error) error {
	attempts := o.Attempts + 1
	status := StatusPending
	if attempts >= maxAttempts {
		status = StatusFailed
	}
	msg := sendErr.Error()
	if len(msg) > 1000 {
		msg = msg[:1000]
	}
	_, err := tx.Exec(ctx, `
		UPDATE mail_outbox
		SET attempts = $2, status = $3, last_error = $4,
		    next_attempt_at = now() + make_interval(mins => $5), updated_at = now()
		WHERE id = $1`, o.ID, attempts, status, msg, 1<<attempts)
	return err
}
```

(Confirm `*orm.Tx` exposes `Query`/`Exec` with pgx semantics — it satisfies `orm.Executor`.)

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/mail/sender.go core/internal/mail/sender_test.go
rtk git commit -m "feat(mail): sender claims due rows with SKIP LOCKED, backs off, fails after 5"
```

---

### Task 4: Admin API and wiring

**Files:**
- Create: `core/internal/mail/handler.go`
- Modify: `core/internal/app/app.go` (`mountRoutes` — beside the notebook/saved_filters groups; `Run` — beside the presence ticker)
- Test: `core/internal/mail/handler_test.go`, `core/internal/app/app_test.go` (route table)

**Interfaces:**
- Consumes: Tasks 1–3; `auth.MustIdentity`.
- Produces: `mail.NewHandler(db *orm.DB) *Handler`; `(*Handler).List` (`GET /api/v1/mail_outbox?status=&page=&page_size=` → `{data, total}`), `(*Handler).Retry` (`POST /api/v1/mail_outbox/:id/retry` → 204, resets a `failed` row to `pending`, `attempts = 0`, `next_attempt_at = now()`).

- [ ] **Step 1: Write the failing test** `handler_test.go` (DB-backed, via the Task 1 `setup`)

```go
package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func call(t *testing.T, h echo.HandlerFunc, method, path, route string, tenant uuid.UUID) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	e.Add(method, route, h)
	req := httptest.NewRequest(method, path, nil)
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: tenant}))
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestHandler(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	h := NewHandler(app.DB)
	if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: "a@x.io", Subject: "s", Text: "t"}); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	_ = app.DB.QueryRow(ctx, `SELECT id FROM mail_outbox WHERE tenant_id = $1`, tenant).Scan(&id)
	_, _ = app.DB.Exec(ctx, `UPDATE mail_outbox SET status = 'failed', attempts = 5 WHERE id = $1`, id)

	t.Run("list filters by status, tenant-pinned", func(t *testing.T) {
		rec := call(t, h.List, http.MethodGet, "/mail_outbox?status=failed", "/mail_outbox", tenant)
		var body struct {
			Data  []map[string]any `json:"data"`
			Total int              `json:"total"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusOK || body.Total != 1 || body.Data[0]["to_address"] != "a@x.io" {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		other := call(t, h.List, http.MethodGet, "/mail_outbox", "/mail_outbox", uuid.New())
		body.Total = -1
		_ = json.Unmarshal(other.Body.Bytes(), &body)
		if other.Code != http.StatusOK || body.Total != 0 {
			t.Errorf("other tenant sees %d %s", other.Code, other.Body)
		}
	})

	t.Run("retry re-queues a failed row", func(t *testing.T) {
		rec := call(t, h.Retry, http.MethodPost, "/mail_outbox/"+id.String()+"/retry", "/mail_outbox/:id/retry", tenant)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		var status string
		var attempts int
		_ = app.DB.QueryRow(ctx, `SELECT status, attempts FROM mail_outbox WHERE id = $1`, id).Scan(&status, &attempts)
		if status != StatusPending || attempts != 0 {
			t.Errorf("status=%s attempts=%d", status, attempts)
		}
	})

	t.Run("retry of another tenant's row is 404", func(t *testing.T) {
		rec := call(t, h.Retry, http.MethodPost, "/mail_outbox/"+id.String()+"/retry", "/mail_outbox/:id/retry", uuid.New())
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})
}
```

Add to `TestApp_Routes`' table in `internal/app/app_test.go`:

```go
		{http.MethodGet, "/api/v1/mail_outbox", nil, http.StatusOK},
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/mail/... ARGS="-run TestHandler"`
Expected: FAIL — `undefined: NewHandler`.

- [ ] **Step 3: Implement** `handler.go`

```go
package mail

import (
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler is the admin view of the outbox (mail_outbox:mail_outbox:read|write,
// route-derived). Tenant-pinned; bodies are not listed — only what an admin
// needs to spot and re-queue a failure.
type Handler struct{ db *orm.DB }

func NewHandler(db *orm.DB) *Handler { return &Handler{db: db} }

type outboxRow struct {
	ID            uuid.UUID  `json:"id"`
	ToAddress     string     `json:"to_address"`
	Subject       string     `json:"subject"`
	Status        string     `json:"status"`
	Attempts      int        `json:"attempts"`
	NextAttemptAt time.Time  `json:"next_attempt_at"`
	LastError     string     `json:"last_error"`
	SentAt        *time.Time `json:"sent_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// List handles GET /api/v1/mail_outbox?status=&page=&page_size=.
func (h *Handler) List(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	status := c.QueryParam("status")
	if status != "" && status != StatusPending && status != StatusSent && status != StatusFailed {
		return echo.NewHTTPError(http.StatusBadRequest, "status must be pending, sent or failed")
	}
	page, _ := echo.QueryParamOr(c, "page", 1)
	size, _ := echo.QueryParamOr(c, "page_size", 50)
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	const where = `WHERE tenant_id = $1 AND deleted_at IS NULL AND ($2 = '' OR status = $2)`
	var total int
	if err := h.db.QueryRow(ctx, `SELECT count(*) FROM mail_outbox `+where, tenant, status).Scan(&total); err != nil {
		return err
	}
	rows, err := h.db.Query(ctx, `
		SELECT id, to_address, subject, status, attempts, next_attempt_at, last_error, sent_at, created_at
		FROM mail_outbox `+where+` ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
		tenant, status, size, (page-1)*size)
	if err != nil {
		return err
	}
	defer rows.Close()
	data := []outboxRow{}
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.ID, &r.ToAddress, &r.Subject, &r.Status, &r.Attempts, &r.NextAttemptAt, &r.LastError, &r.SentAt, &r.CreatedAt); err != nil {
			return err
		}
		data = append(data, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": data, "total": total})
}

// Retry handles POST /api/v1/mail_outbox/:id/retry — a failed (or stuck
// pending) row goes back to pending with a fresh attempt budget.
func (h *Handler) Retry(c *echo.Context) error {
	ctx := c.Request().Context()
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}
	tag, err := h.db.Exec(ctx, `
		UPDATE mail_outbox SET status = $3, attempts = 0, next_attempt_at = now(), updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND status <> $4 AND deleted_at IS NULL`,
		id, auth.MustIdentity(ctx).TenantID, StatusPending, StatusSent)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return echo.NewHTTPError(http.StatusNotFound)
	}
	return c.NoContent(http.StatusNoContent)
}
```

(A `sent` row is never re-sent by retry — only `failed`; retrying a `pending` row is a no-op 404, which is fine: it's already queued.) Adjust the `status <> $4` clause to `status = 'failed'` if that reads clearer — the test only covers `failed`.

`app.go` — `mountRoutes`, next to the saved-filters group:

```go
	// Mail outbox admin (internal/mail): mail_outbox:mail_outbox:read|write, route-derived.
	mailHandler := mail.NewHandler(app.DB)
	mailGroup := srv.Echo().Group("/api/v1/mail_outbox", jwtMw, permMw)
	mailGroup.GET("", mailHandler.List)
	mailGroup.POST("/:id/retry", mailHandler.Retry)
```

`Run`, after the presence ticker:

```go
	// Mail outbox sender (internal/mail): delivers queued email every 30 s.
	// Without smtp_host, mail stays pending until SMTP is configured.
	if mail.Configured(a.cfg) {
		go mail.NewSender(app.DB, mail.NewSMTPTransport(a.cfg)).Run(ctx)
	} else {
		common.Logger.Warn("⚠️  smtp_host not configured — queued mail will not be sent")
	}
```

- [ ] **Step 4: Run to verify it passes, plus the app suite**

Run: `rtk make run-back-tests BACKTESTPATH=./internal/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add core/internal/mail core/internal/app
rtk git commit -m "feat(mail): outbox admin API; start the sender when SMTP is configured"
```

---

### Task 5: Mailpit, config templates, docs, and an end-to-end check

**Files:**
- Modify: `compose.yml`, `compose.prod.yml`, `eerp-config.example.json`, `eerp-config.docker.example.json`, `eerp-config.prod.example.json`, `infra/bootstrap.sh` (only if it templates config keys explicitly — check), `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Compose**

`compose.yml`, after the `redis` service:

```yaml
  # Dev mail catcher (internal/mail): every email the outbox sends lands in
  # the Mailpit inbox at http://127.0.0.1:8025 — nothing reaches a real
  # address. Optional like redis: core-back waits on it with required: false.
  mailpit:
    image: axllent/mailpit:v1.27
    restart: always
    container_name: mailpit
    ports:
      - "127.0.0.1:8025:8025"   # web UI
      - "127.0.0.1:1025:1025"   # SMTP, for host-native runs
    healthcheck:
      test: ["CMD", "/mailpit", "readyz"]
      interval: 5s
      timeout: 5s
      retries: 10
```

and under `core-back.depends_on`:

```yaml
      mailpit:
        condition: service_healthy
        required: false
```

`compose.prod.yml`: disable it (an override can't delete a service; a profile no one enables does the same):

```yaml
  mailpit:
    profiles: ["dev-only"]   # never started in production — point smtp_* at a real relay
    ports: !reset []
```

Check the Mailpit image tag and its healthcheck command against the image's docs (`docker run --rm axllent/mailpit:v1.27 readyz --help`); if `readyz` is absent, use `["CMD", "wget", "-qO-", "http://127.0.0.1:8025/readyz"]`.

- [ ] **Step 2: Config templates**

`eerp-config.docker.example.json`: `"smtp_host": "mailpit", "smtp_port": 1025, "smtp_tls": "none", "smtp_from": "EERP <no-reply@eerp.localhost>"`.
`eerp-config.example.json` (host-native dev): same with `"smtp_host": "127.0.0.1"`.
`eerp-config.prod.example.json`: `"smtp_host": "", "smtp_port": 587, "smtp_tls": "starttls", "smtp_user": "", "smtp_password": "", "smtp_from": ""`.
Run `rtk rg -n "redis_url" infra/bootstrap.sh` — if bootstrap copies keys one by one, add the smtp keys the same way; if it copies whole templates, nothing to do.

- [ ] **Step 3: End-to-end check against Mailpit**

```bash
rtk docker compose up -d mailpit db
```

Add a throwaway test (not committed) or use `psql` to enqueue one row for the dev tenant, run the backend (`make run-back`), wait ≤ 30 s, then:

```bash
rtk curl -s http://127.0.0.1:8025/api/v1/messages
```

Expected: one message, subject and UTF-8 body intact. Record the result in the task report; delete the row afterwards.

- [ ] **Step 4: Docs** — root `CLAUDE.md`:
  - In "Key internal packages", add after `internal/cron/`:

```markdown
- `internal/mail/` — transactional email (outbox pattern): `mail.Enqueue(ctx, ex, Message)` inserts a `mail_outbox` row through the caller's executor — pass the `*orm.Tx` so the email commits or rolls back with the business write. `mail.Sender` (started by `App.Run` only when `smtp_host` is set) ticks every 30 s, claims up to 20 due rows `FOR UPDATE SKIP LOCKED` (safe with several `core-back` processes), sends through `net/smtp` (`smtp_tls`: `starttls`|`implicit`|`none`), and backs off `2^attempts` minutes, marking the row `failed` after 5 attempts. Delivery is at-least-once (a crash between the relay's accept and COMMIT re-sends). Off the generic CRUD surface; `GET /api/v1/mail_outbox` + `POST /api/v1/mail_outbox/:id/retry` (permissions `mail_outbox:mail_outbox:*`) are the admin view. Dev: the `mailpit` compose service catches everything (UI `127.0.0.1:8025`). Pitfall: never send inline from a request — enqueue, so a slow relay can't fail the business write.
```

  - In "Configuration", mention `smtp_*` next to `redis_url` and add Mailpit to the published-ports sentence (`127.0.0.1:8025` UI, `:1025` SMTP).
  - Add `mailpit` to the deployment-topology mermaid: `Back -.->|"SMTP (smtp_host)"| Mail[("Mailpit / SMTP relay")]`.

- [ ] **Step 5: Lint and full backend suite**

Run (from `core/`): `rtk golangci-lint run ./...` then `rtk make run-back-tests`
Expected: clean, PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add compose.yml compose.prod.yml eerp-config*.example.json CLAUDE.md infra
rtk git commit -m "chore(mail): Mailpit in dev compose, smtp_* config templates, docs"
```
