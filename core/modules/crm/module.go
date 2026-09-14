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
	if err := orm.Register[internal.CRM](); err != nil {
		return err
	}
	// Tag + junction back the relation/tags demo: /api/v1/tag and /api/v1/crm_tag
	// on the generic surface (permissions tag:tag:* / crm_tag:crm_tag:* derive
	// from the routes).
	if err := orm.Register[internal.Tag](); err != nil {
		return err
	}
	return orm.Register[internal.CrmTag]()
}
