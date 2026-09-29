package mail

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/orm"
)

// Registered here, not in core/modules/mail, so this package's own tests can
// migrate the schema without an import cycle; core/modules/mail just imports us.
func init() { module.RegisterGoModule(&mailModule{}) }

type mailModule struct{}

func (m *mailModule) Name() string { return "mail" }

// Register keeps mail_outbox OFF the generic CRUD surface (addresses and
// bodies); internal/mail's admin handler is the only HTTP path to it.
func (m *mailModule) Register() error {
	return orm.Register[Outbox](orm.WithTableName("mail_outbox"), orm.WithExcluded())
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
