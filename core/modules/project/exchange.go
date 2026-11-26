package project

import (
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
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
	// Collapsed is an export-only display hint (the Gantt's folded rows): the
	// format shows the task folded. Never decoded, never diffed.
	Collapsed bool
	// Priority is EERP's high-priority flag (the Eisenhower matrix's axis).
	Priority bool
	// Notes is the task's description, as plain text.
	Notes string
	// ActualHours is the time booked on the task. Export only: an import never
	// writes timesheets.
	ActualHours float64
}

// BaselineTask is one task's frozen schedule in a baseline, in the file's terms.
type BaselineTask struct {
	Start    time.Time
	Duration int
	Work     float64
}

// PlanBaseline is one baseline of the plan. Number is the file's slot: 0 is the
// newest EERP baseline, up to 10 (the eleven MS Project holds).
type PlanBaseline struct {
	Number int
	Tasks  map[string]BaselineTask // by task Key()
}

// PlanResource is a person of the plan with their weekly capacity. Capacities are
// workspace-wide in EERP: a plan carries them for its assignees only.
type PlanResource struct {
	Email, Name  string
	HoursPerWeek float64
}

// Key is the task's identity inside a Plan, used by Parent, PlanDep and
// PlanAssign. It is stable for a given file and a given project state, which is
// what lets a diff's change keys survive a preview/apply round trip.
//
// The two "new" prefixes are EERP's own namespace: no Ref a file supplies may
// look like them, which is what validRef is for.
func (t PlanTask) Key() string {
	if t.Ref != "" {
		return t.Ref
	}
	if t.Milestone {
		return "new-milestone:" + t.FileID
	}
	return "new:" + t.FileID
}

// nestedDeps reports, by index into p.Deps, the dependencies that link a task
// and one of its own ancestors (Parent chain, keys as Key() writes them). A
// summary task spans its subtasks, so such a link is a loop: GanttProject and MS
// Project refuse it, and EERP no longer accepts one either. Parent loops (only a
// buggy plan holds one) end the walk instead of looping.
func (p Plan) nestedDeps() map[int]bool {
	parent := make(map[string]string, len(p.Tasks))
	for _, t := range p.Tasks {
		if _, dup := parent[t.Key()]; !dup {
			parent[t.Key()] = t.Parent
		}
	}
	under := func(k, anc string) bool {
		seen := map[string]bool{}
		for k = parent[k]; k != "" && !seen[k]; k = parent[k] {
			if k == anc {
				return true
			}
			seen[k] = true
		}
		return false
	}
	out := map[int]bool{}
	for i, d := range p.Deps {
		if d.Pred != d.Succ && (under(d.Pred, d.Succ) || under(d.Succ, d.Pred)) {
			out[i] = true
		}
	}
	return out
}

// milestoneRefPrefix marks an eerp_id that names a milestone rather than a task
// (spec "Matching and change keys"). Task 4's loader builds the same shape from
// a milestone row's id.
const milestoneRefPrefix = "milestone:"

// validRef reports whether an identity a file carries is one EERP can recognise:
// a task uuid, or milestoneRefPrefix plus a uuid. It is the one rule the .gan
// decoder, Task 4's loader and Task 5's diff share.
//
// It exists to keep the synthetic half of the Key() namespace closed. Key()
// builds a new row's key from its FileID, so a file allowed to put "new:7" in
// eerp_id would be handed the key of another row, and that row would vanish from
// the diff without a word. A Ref that passes validRef can never be such a key:
// only the exact milestoneRefPrefix is stripped, and every remaining form is a
// uuid, which begins with a hex digit; "new" and "new-milestone" do not.
//
// A Ref that passes is well formed, not known: whether it names a task of this
// project is the diff's call, and it answers with the UNKNOWN_ID warning. The
// encoder writes EERP's own ids back verbatim and does not consult this.
func validRef(ref string) bool {
	if rest, ok := strings.CutPrefix(ref, milestoneRefPrefix); ok {
		ref = rest
	}
	_, err := uuid.Parse(ref)
	return err == nil
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
	Tasks []PlanTask
	// Deps is every dependency of the plan, and its slice order means nothing:
	// each format puts the dependencies where its own file puts them (the .gan
	// one hangs each <depend> off its predecessor, so a decoded file comes back
	// grouped by predecessor in document order), and a plan loaded from EERP comes
	// back in whatever order its rows were read. Two plans' dependencies are the
	// same when they hold the same PlanDeps, so any comparison must be a
	// set/multiset comparison, never DeepEqual on the slices: a diff that compared
	// order would report change rows on a file nobody touched.
	Deps        []PlanDep
	Assignments []PlanAssign
	// Baselines are the newest baselines, Number 0 the newest (see PlanBaseline).
	Baselines []PlanBaseline
	// Resources is one entry per assignee email, with their capacity.
	Resources []PlanResource
}

// Warning is something in a file EERP cannot hold. It never blocks an import:
// the file's value is dropped or degraded, and the wizard lists it. Code is one
// of UNKNOWN_ID, DUPLICATE_ID, DEP_TYPE, DEP_LAG, DEP_FROM_MILESTONE, DEP_NESTED,
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
	// Carries reports whether the format's files hold field f. The diff compares
	// only the fields both sides can hold: a field the file never carries reads as
	// absent, and a diff that took it for "cleared" would wipe it on import.
	Carries(f Field) bool
}

// Field is one kind of data a plan file may or may not carry (Format.Carries).
type Field string

const (
	FieldName        Field = "name"
	FieldDates       Field = "dates"
	FieldHours       Field = "planned_hours"
	FieldClosed      Field = "closed"
	FieldMilestone   Field = "milestone_id"
	FieldPriority    Field = "priority"
	FieldDescription Field = "description"
	FieldBaselines   Field = "baselines"
	FieldCapacity    Field = "capacity"
)

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
