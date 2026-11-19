package mail

import (
	"context"
	"encoding/json"
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
	attachments := ""
	if len(m.Attachments) > 0 {
		raw, err := json.Marshal(m.Attachments)
		if err != nil {
			return err
		}
		attachments = string(raw)
	}
	_, err := ex.Exec(ctx, `
		INSERT INTO mail_outbox (tenant_id, to_address, subject, body_text, body_html, attachments, status, next_attempt_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
		m.TenantID, m.To, m.Subject, m.Text, m.HTML, attachments, StatusPending)
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

func mailAddress(s string) (string, error) {
	a, err := mail.ParseAddress(s)
	if err != nil {
		return "", err
	}
	return a.Address, nil
}
