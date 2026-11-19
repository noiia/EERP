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
// bodies); internal/mail's admin handler is the only HTTP path to it. Same
// for mail_template: its writes must be validated and sanitized
// (internal/mail's TemplateHandler, Settings → Email templates).
func (m *mailModule) Register() error {
	if err := orm.Register[mail.Outbox](orm.WithTableName("mail_outbox"), orm.WithExcluded()); err != nil {
		return err
	}
	return orm.Register[mail.Template](orm.WithTableName("mail_template"), orm.WithExcluded())
}

// Migrate adds the index the sender's due-row claim scans, and the one
// (tenant, key, locale) a template override is unique on.
func (m *mailModule) Migrate(ctx context.Context, db *orm.DB) error {
	if _, err := db.Exec(ctx, `
		CREATE INDEX IF NOT EXISTS idx_mail_outbox_due
		ON mail_outbox (status, next_attempt_at)`); err != nil {
		return fmt.Errorf("mail: create due index: %w", err)
	}
	if _, err := db.Exec(ctx, mail.TemplateUniqueIndex); err != nil {
		return fmt.Errorf("mail: create template index: %w", err)
	}
	return nil
}
