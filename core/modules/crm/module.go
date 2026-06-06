package crm

import (
	"core/internal/module"
	"core/modules/crm/internal"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&crmModule{})
}

type crmModule struct{}

func (m *crmModule) Name() string { return "crm" }

func (m *crmModule) Register() error {
	return orm.Register[internal.CRM]()
}
