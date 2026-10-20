package contact

import (
	"context"
	"fmt"

	"core/internal/module"
	"core/modules/contact/internal"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&contactModule{})
}

type contactModule struct{}

func (m *contactModule) Name() string { return "contact" }

func (m *contactModule) Register() error {
	if err := orm.Register[internal.Contact](); err != nil {
		return err
	}
	return orm.Register[internal.ContactCompany]()
}

// Migrate links each (contact, company) pair at most once among live rows,
// and reads a contact from before kinds existed as a person ("contact").
func (m *contactModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, ddl := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_company_unique
			ON contact_company (contact_id, company_id) WHERE deleted_at IS NULL`,
		`UPDATE contact SET kind = 'contact' WHERE kind IS NULL`,
	} {
		if _, err := db.Exec(ctx, ddl); err != nil {
			return fmt.Errorf("contact: migrate: %w", err)
		}
	}
	return nil
}
