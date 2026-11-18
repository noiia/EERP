package project

import (
	"io"
	"time"
)

// The exchange layer moves a project's schedule between EERP and a desktop
// planner's file. Everything between the two lives in one neutral model, Plan,
// and one adapter per file family implements Format. A format never touches the
// database and the diff never touches a file: the file's own conventions (here
// the .gan ones, see gan.go) stay inside the adapter.
//
// The shape of the exchange (spec docs/superpowers/specs/
// 2026-11-18-project-gantt-exchange-design.md):
//
//	file      --Decode--> Plan (the file's plan)
//	database  --load----> Plan (the current plan)      loaded in Task 4
//	the two Plans --diff--> []Change                    diffed in Task 5
//	ticked keys --apply--> database                     applied in Task 7
//	current Plan --Encode--> file                       exported in Task 6

// DepType is a dependency type in the file's terms. EERP only knows
// finish-to-start; the other three exist in a partner's file and are reported,
// never applied.
type DepType int

const (
	// DepFS is finish to start: the successor starts after the predecessor ends.
	// The only type EERP can hold.
	DepFS DepType = iota
	DepSS
	DepFF
	DepSF
)

// PlanTask is one task or milestone of a Plan, in the file's terms: whole days,
// durations in working days, completion as a percentage.
type PlanTask struct {
	// Ref is the EERP identity carried by the file: the task uuid, or
	// "milestone:<uuid>" for a milestone. "" for a task the file added.
	Ref string
	// FileID is the id the file uses internally (the .gan task id). "" on a plan
	// loaded from EERP, which has no file.
	FileID string
	Name   string
	// Parent is the Key() of the parent task, "" at the top level.
	Parent string
	// Start is always day() normalised.
	Start time.Time
	// Duration is in working days, 0 for a milestone.
	Duration int
	// PlannedHours is the file's figure; the diff compares at 0.01 precision.
	PlannedHours float64
	// Complete is 0..100. Only 100 means closed, and only closed means 100.
	Complete  int
	Milestone bool
	// Undated is set on a loaded plan only: Start and Duration there are the
	// deterministic placeholder, not dates the manager chose.
	Undated bool
	// HasChildren marks a summary task, whose dates a planner derives from its
	// children; the diff ignores a summary task's dates and completion.
	HasChildren bool
}

// Key is the task's identity inside a Plan, used by Parent, PlanDep and
// PlanAssign. It is stable for a given file and a given project state, which is
// what lets a diff's change keys survive a preview/apply round trip.
func (t PlanTask) Key() string {
	if t.Ref != "" {
		return t.Ref
	}
	if t.Milestone {
		return "new-milestone:" + t.FileID
	}
	return "new:" + t.FileID
}

// PlanDep is a dependency between two tasks, named by Key().
type PlanDep struct {
	Pred, Succ string
	Type       DepType
	// Lag is in days. Only 0 exists in EERP, so a non-zero lag is reported, not
	// applied.
	Lag int
}

// PlanAssign is one assignment of a person to a task. Task is a Key(); the
// person is their email, which is how a file names staff, with Name as the
// display label the partner sees.
type PlanAssign struct {
	Task  string
	Email string
	Name  string
}

// Plan is a project's schedule in the terms of one file format, whether it came
// from that file or from EERP. The diff only ever compares two Plans, never a
// file value against a database value, so what the planner recalculates on save
// cannot show up as a change.
type Plan struct {
	Name string
	// Weekend is the plan's calendar. Holidays are not modelled: a file that
	// defines them is read with weekends only, plus a HOLIDAYS warning.
	Weekend     Weekend
	HasHolidays bool
	// Tasks is document order (pre-order, a parent before its children), with
	// milestones last. Encoding writes, and decoding normalises to, that order.
	Tasks       []PlanTask
	Deps        []PlanDep
	Assignments []PlanAssign
}

// Warning is something in a file EERP cannot hold. It never blocks an import:
// the file's value is dropped or degraded, and the wizard lists it. Code is one
// of UNKNOWN_ID, DUPLICATE_ID, DEP_TYPE, DEP_LAG, DEP_FROM_MILESTONE,
// MULTI_MILESTONE, UNKNOWN_EMAIL, NAME_TRUNCATED, HOLIDAYS; Task names the file
// task it is about, when it is about one.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Task    string `json:"task,omitempty"`
}

// Format is one file family. Decode's error means "this is not this format" and
// the route answers 422 INVALID_FILE; a file that is this format but carries
// something EERP cannot hold decodes fine and returns warnings instead.
type Format interface {
	// Key names the format in the routes (/exchange/:format/…).
	Key() string
	// Ext is the file extension, with the dot: ".gan".
	Ext() string
	Encode(w io.Writer, p Plan) error
	Decode(r io.Reader) (Plan, []Warning, error)
}

// formats is the registry the routes resolve :format against. Each format file
// fills it from its init().
var formats = map[string]Format{}

// registerFormat adds f to the registry, keyed by its Key(). Re-registering a
// key replaces the format: registration order is init() order, which is fixed
// per file, so a duplicate key is a bug rather than a race.
func registerFormat(f Format) {
	formats[f.Key()] = f
}

// formatByKey resolves a route's :format. An unknown key is a 404, not a 422:
// the file was never read.
func formatByKey(key string) (Format, bool) {
	f, ok := formats[key]
	return f, ok
}
