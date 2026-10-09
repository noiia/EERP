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
	// ctx only bounds transport.Send: on shutdown, DB work must still commit the
	// sent marks already earned, or every mail of the batch would be re-sent.
	dbctx := context.WithoutCancel(ctx)
	err = orm.Transact(dbctx, s.db, func(tx *orm.Tx) error {
		sent, failed = 0, 0
		claim := orm.MustRepo[Outbox](s.db).SelectForUpdate().SkipLocked().
			Where(orm.Cond("status = $1 AND next_attempt_at <= now()", StatusPending)).
			OrderBy("next_attempt_at").
			Limit(batchSize)
		if tenant != uuid.Nil {
			claim = claim.Where(orm.Cond("tenant_id = $1", tenant))
		}
		due, err := claim.All(dbctx, tx)
		if err != nil {
			return err
		}
		for _, o := range due {
			if ctx.Err() != nil {
				break
			}
			if sendErr := s.transport.Send(ctx, o); sendErr != nil {
				if ctx.Err() != nil {
					break // aborted by shutdown, not a relay failure: stay pending, no attempt burned
				}
				failed++
				if err := markFailed(dbctx, tx, o, sendErr); err != nil {
					return err
				}
				continue
			}
			sent++
			if _, err := tx.Exec(dbctx,
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
