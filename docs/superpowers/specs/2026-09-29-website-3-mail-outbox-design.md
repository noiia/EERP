# Spec 3 — Mail outbox

**Date:** 2026-09-29 · **Status:** draft · **Depends on:** nothing
· **Overview:** [website overview](2026-09-29-website-overview.md)

## Problem
EERP sends no email today. Booking confirmations, cancel links and account verification need
delivery that never blocks or fails the business write, and never reaches real inboxes in dev.

## Design — `core/internal/mail`
**Table `mail_outbox`** (off the generic CRUD surface — rows hold addresses and bodies):
`tenant_id, to_address, subject, body_text, body_html, status (pending|sent|failed), attempts,
next_attempt_at, last_error, sent_at` + BaseModel. Index on `(status, next_attempt_at)`.

**Enqueue** — `mail.Enqueue(ctx, tx *orm.Tx, Message)` inserts inside the caller's transaction:
the business row and its email commit or roll back together (transactional outbox).

**Sender** — `mail.Sender.Run(ctx)` on a 30 s ticker started by `App.Run` (same shape as the
presence sweep):
1. In a transaction, `SELECT … WHERE status='pending' AND next_attempt_at <= now() ORDER BY
   next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED` — safe with several `core-back` processes.
2. Send each via `net/smtp` (STARTTLS when offered, implicit TLS when `smtp_tls: "implicit"`),
   multipart text + html.
3. Success → `sent`; failure → `attempts+1`, `next_attempt_at = now() + 2^attempts min`,
   `failed` after 5 attempts with `last_error` kept.

**Config** (`types.Config`): `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`,
`smtp_from`, `smtp_tls` (`starttls`|`implicit`|`none`). `smtp_host` empty → the sender is not
started; `Enqueue` still writes rows, delivered once SMTP is configured.

**Templates** — Go `html/template` + `text/template` embedded per sender module (spec 4 owns the
booking templates); `internal/mail` only transports.

**Admin view** — `GET /api/v1/mail_outbox` (list, filter by status) + `POST
/api/v1/mail_outbox/:id/retry` (reset to pending), dedicated tenant-pinned handler, permissions
`mail_outbox:mail_outbox:*` derived from the routes; shown as Website → Outbox.

## Dev infra
- `compose.yml`: `mailpit` service (`axllent/mailpit`), SMTP `:1025` internal, web UI published
  on `127.0.0.1:8025`; `core-back` gets `depends_on … required: false`.
- `eerp-config.docker.json.example`: `smtp_host: "mailpit"`, `smtp_port: 1025`, `smtp_tls: "none"`.
- `compose.prod.yml`: no mailpit; prod config points at a real relay.

## Testing
DB-backed: enqueue rolled back with its tx leaves no row; two concurrent claimers never send the
same row (`SKIP LOCKED`); backoff and `failed` after 5 attempts against a fake SMTP dialer
(the dialer is an interface at the call site).

## Out of scope
Bounce handling, templates editable by users, attachments, per-tenant SMTP.
