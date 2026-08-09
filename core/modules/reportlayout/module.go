package reportlayout

import (
	"core/internal/module"
	"core/modules/reportlayout/internal"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&reportLayoutModule{})
}

type reportLayoutModule struct{}

func (m *reportLayoutModule) Name() string { return "reportlayout" }

func (m *reportLayoutModule) Register() error {
	return orm.Register[internal.ReportPageFormat]()
}
