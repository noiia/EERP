package cron

import (
	"core/internal/cron"
	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&cronModule{})
}

type cronModule struct{}

func (m *cronModule) Name() string { return "cron" }

// Register puts both tables on the GENERIC CRUD surface (no WithExcluded) —
// unlike chatter/notebook/savedfilter, Cron/CronHistory need no visibility
// rule the generic filter chain can't express, and riding the generic
// surface is what gives them List/Kanban/Calendar/Graph for free through
// the standard view engine (docs/adr/ADR-016-cron-scheduler.md) instead of
// a hand-built frontend.
func (m *cronModule) Register() error {
	if err := orm.Register[cron.Cron](); err != nil {
		return err
	}
	return orm.Register[cron.CronHistory]()
}
