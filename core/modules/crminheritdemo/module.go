package crminheritdemo

import (
	"time"

	// Non-blank import: forces crm.init() before crminheritdemo.init() AND
	// gives us the exported crm.CRM type to embed.
	"core/modules/crm"

	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&crminheritdemoModule{})
}

// ExtendedCRM embeds the base CRM entity and adds crminheritdemo-specific fields.
// Registered under the "crm" table name, it replaces the base registration so
// the generic API automatically includes date and comment — the crm module is
// never touched.
type ExtendedCRM struct {
	crm.CRM
	Date    *time.Time `db:"date"`
	Comment string     `db:"comment"`
}

type crminheritdemoModule struct{}

func (m *crminheritdemoModule) Name() string { return "crminheritdemo" }

func (m *crminheritdemoModule) Register() error {
	return orm.Register[ExtendedCRM](orm.WithTableName("crm"))
}
