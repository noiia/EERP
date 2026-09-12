package contact

import (
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
	return orm.Register[internal.Contact]()
}
