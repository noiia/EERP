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
	// Attachments is the JSON of the message's []Attachment ("" = none) —
	// text, so the column needs no driver-specific type.
	Attachments string `db:"attachments"`
}

// Message is what a caller enqueues. Text is required (every client can show
// it); HTML is optional and sent as the preferred alternative.
type Message struct {
	TenantID uuid.UUID
	To       string
	Subject  string
	Text     string
	HTML     string
	// Attachments ride with the message, e.g. a calendar invite (.ics).
	Attachments []Attachment
}

// Attachment is one file attached to a message; Data is base64 in JSON.
type Attachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"`
}
