// Package cron owns background scheduled actions: the Cron/CronHistory
// tables (registered on the generic CRUD surface by core/modules/cron, so
// List/Kanban/Calendar/Graph all come from the standard view engine — see
// docs/adr/ADR-016-cron-scheduler.md for why this table pair, unlike
// chatter/notebook/savedfilter, does NOT need a dedicated off-CRUD handler),
// the Action registry a module's own cron.go file populates, the polling
// Scheduler that runs due crons as their configured user, and the sliding
// retention sweep over cron_history.
package cron

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// Cron is one scheduled action, user-creatable from Settings -> Developer ->
// Crons (docs/adr/ADR-016-cron-scheduler.md). Unlike a traditional crontab
// entry, ExecutionDate is a single point in time, not a recurring interval
// expression — the request this shipped from named exactly two form fields
// (a name and a date), so v1 is "run once at ExecutionDate," not "run every
// N minutes forever." The scheduler clears ExecutionDate back to nil after a
// run so it never re-fires; an action that wants to reschedule itself is
// free to set a new ExecutionDate as part of its own Run (e.g. by calling
// back into the cron repository), the same way any other side effect works.
type Cron struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	Name     string    `db:"name"`
	// ActionID names a registered Action (see registry.go) — which Go code
	// runs. Plain text, not validated against the registry at write time:
	// the generic CRUD surface has no per-field validation hook, and an
	// unknown id is already handled the same way any other failure is (the
	// scheduler records a failed CronHistory run naming the problem), so a
	// second, earlier validation layer would just duplicate that path for a
	// mistake the very next run already surfaces clearly.
	ActionID string `db:"action_id"`
	// ActionCode is a read-only mirror of the resolved Action's Source (the
	// registering module's own cron.go file, embedded at compile time) —
	// the form's notebook "Code" page renders this as a display-only field.
	// Populated by core/modules/cron's Create/Update route override
	// (mirrors crminheritdemo's Create override — the generic CRUD surface
	// has no before-insert hook), not written by the scheduler.
	ActionCode string `db:"action_code"`
	// ExecutionDate is nil once no run is scheduled (a brand-new cron, or
	// one that already ran). The scheduler only ever picks up rows where
	// this is set, in the past, and Status is "active".
	ExecutionDate *time.Time `db:"execution_date"`
	// Status drives the form/Kanban lifecycle: "deactivated" (default —
	// never picked up by the scheduler), "active" (eligible once
	// ExecutionDate is due), "archived" (kept for history, never picked up
	// — same intent as deactivated, a separate value only so Kanban can
	// keep it visually distinct from a deliberately-off cron).
	Status string `db:"status"`
	// RunAsUserID is who the scheduler impersonates for the permission
	// check before Run fires (see scheduler.go) — never the operator who
	// happens to be logged in when the row was created.
	RunAsUserID *uuid.UUID `db:"run_as_user_id"`
	// HistoryRetentionYears overrides the sliding-window default (1 year,
	// retentionDefaultYears in retention.go) for how long THIS cron's own
	// history rows + log files survive. 0 (a fresh row before the
	// Create override defaults it) reads as "use the default," never
	// "delete immediately."
	HistoryRetentionYears int `db:"history_retention_years"`
}

// CronHistory is one execution attempt of a Cron. CreatedAt (from
// BaseModel) doubles as "when this run happened" — the calendar's past-runs
// view positions rows by it, so no separate timestamp column duplicates
// what BaseModel already provides.
type CronHistory struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	CronID   uuid.UUID `db:"cron_id,index"`
	// Failed is true when the run errored (unknown action, missing/under-
	// permissioned run-as user, or the action's own Run returning an
	// error) — named so a truthy value always means "highlight this row,"
	// matching the calendar's calendarColorField convention (a boolean
	// field where true marks the record for red).
	Failed bool `db:"failed"`
	// LogsFilepath is the on-disk path (under Config.CronLogDir) of this
	// run's captured output — downloadable via GET
	// /api/v1/cron_history/:id/log (handler.go).
	LogsFilepath string `db:"logs_filepath"`
}
