package project

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// The current half of the exchange: the project as it stands in EERP, read into
// the neutral Plan so the diff only ever compares two Plans (see exchange.go).
//
// Everything here is a read of what the database holds, in the file's terms:
// whole days, working-day durations, 0-or-100 completion. Nothing is corrected,
// guessed or normalised beyond the two rules the file needs and the manager never
// chose for themselves: the duration a pair of dates means on the file's calendar,
// and the deterministic placeholder for a task with no dates at all. Both are what
// makes an untouched round trip report no changes (spec "Comparing in the file's
// terms").
//
// Every query is plain SQL through the caller's orm.Executor, tenant-pinned by
// argument and filtered on deleted_at IS NULL, so the same read works on the pool
// (a preview) and inside the import's transaction.

// loadPlan reads tenant's project pid as a Plan on the calendar w.
//
// The caller passes the calendar of the file it is about to compare with, not
// EERP's default: a duration is a working-day count, so the only mask under which
// the current plan's durations mean the same thing as the file's is the file's own
// (spec: "cur: loaded with the FILE's weekend"). Name stays empty; the project's
// label belongs to the exported file, and the base hash must not move when a
// manager renames the project (see exportPlan).
func loadPlan(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID, w Weekend) (Plan, error) {
	var projectStart *time.Time
	if err := ex.QueryRow(ctx, `SELECT date_start FROM project
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, pid, tenant).Scan(&projectStart); err != nil {
		return Plan{}, err
	}

	rows, err := readPlanTasks(ctx, ex, tenant, pid)
	if err != nil {
		return Plan{}, err
	}
	milestones, err := readPlanMilestones(ctx, ex, tenant, pid)
	if err != nil {
		return Plan{}, err
	}

	// The order is the file's: a parent before its children, each child after its
	// elder siblings, milestones last (the invariant Plan promises).
	slices.SortStableFunc(rows, byWbs)

	p := Plan{Weekend: w}
	for _, row := range rows {
		p.Tasks = append(p.Tasks, row.planTask(projectStart, w))
	}
	for _, row := range milestones {
		p.Tasks = append(p.Tasks, row.planTask(projectStart))
	}

	p.Deps, err = readPlanDeps(ctx, ex, tenant, pid, rows, milestoneKeys(milestones))
	if err != nil {
		return Plan{}, err
	}
	if p.Assignments, err = readPlanAssignments(ctx, ex, tenant, pid); err != nil {
		return Plan{}, err
	}
	return p, nil
}

// ── The rows ─────────────────────────────────────────────────────────────────

// planTaskRow is one live project_task read for the plan, with the columns the
// file's terms need. The two date columns stay pointers: which of them is set is
// what decides between a duration, a stand-in, and the placeholder.
type planTaskRow struct {
	id           uuid.UUID
	name         string
	parentID     *uuid.UUID
	milestoneID  *uuid.UUID
	dateStart    *time.Time
	deadline     *time.Time
	createdAt    time.Time
	plannedHours float64
	closed       bool
	wbs          []int
	hasChildren  bool
}

// readPlanTasks reads the project's live tasks. The order comes from Go (byWbs),
// not from SQL: wbs_number is text, and a text sort would put 2.10 before 2.2.
func readPlanTasks(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID) ([]planTaskRow, error) {
	rows, err := ex.Query(ctx, `SELECT t.id, t.name, t.parent_id, t.milestone_id, t.date_start, t.deadline,
			t.created_at, t.planned_hours, t.closed, t.wbs_number,
			EXISTS (SELECT 1 FROM project_task c
				WHERE c.parent_id = t.id AND c.tenant_id = t.tenant_id AND c.deleted_at IS NULL)
		FROM project_task t
		WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL`, tenant, pid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []planTaskRow
	for rows.Next() {
		var (
			row     planTaskRow
			wbs     *string
			hasKids bool
		)
		if err := rows.Scan(&row.id, &row.name, &row.parentID, &row.milestoneID, &row.dateStart, &row.deadline,
			&row.createdAt, &row.plannedHours, &row.closed, &wbs, &hasKids); err != nil {
			return nil, err
		}
		row.wbs = wbsParts(wbs)
		row.hasChildren = hasKids
		out = append(out, row)
	}
	return out, rows.Err()
}

// planTask turns the row into the file's terms. Undated is what says so out loud:
// the start and duration that go with it are EERP's placeholder, not a date the
// manager chose, and the wizard labels a change on such a row accordingly.
func (r planTaskRow) planTask(projectStart *time.Time, w Weekend) PlanTask {
	start, duration, undated := planDates(r.dateStart, r.deadline, placeholderDay(projectStart, r.createdAt), w)
	complete := 0
	if r.closed {
		complete = 100 // only 100 means closed, and only closed means 100 (spec field mapping)
	}
	task := PlanTask{
		Ref:          r.id.String(),
		Name:         r.name,
		Start:        start,
		Duration:     duration,
		PlannedHours: r.plannedHours,
		Complete:     complete,
		Undated:      undated,
		HasChildren:  r.hasChildren,
	}
	if r.parentID != nil {
		task.Parent = r.parentID.String()
	}
	return task
}

// planMilestoneRow is one live project_milestone. A milestone has the one date
// (its deadline), holds no planned hours and is never closed in the file's sense,
// so the three come back as their empty values rather than as invented ones.
type planMilestoneRow struct {
	id        uuid.UUID
	name      string
	deadline  *time.Time
	createdAt time.Time
}

func readPlanMilestones(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID) ([]planMilestoneRow, error) {
	rows, err := ex.Query(ctx, `SELECT id, name, deadline, created_at FROM project_milestone
		WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
		ORDER BY created_at, id`, tenant, pid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []planMilestoneRow
	for rows.Next() {
		var row planMilestoneRow
		if err := rows.Scan(&row.id, &row.name, &row.deadline, &row.createdAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (r planMilestoneRow) planTask(projectStart *time.Time) PlanTask {
	start, undated := placeholderDay(projectStart, r.createdAt), true
	if r.deadline != nil {
		start, undated = day(*r.deadline), false
	}
	return PlanTask{
		Ref:       milestoneRefPrefix + r.id.String(),
		Name:      r.name,
		Start:     start,
		Milestone: true,
		Undated:   undated,
	}
}

func milestoneKeys(rows []planMilestoneRow) map[string]bool {
	out := make(map[string]bool, len(rows))
	for _, row := range rows {
		out[milestoneRefPrefix+row.id.String()] = true
	}
	return out
}

// readPlanDeps reads the project's live dependencies whose two ends are live tasks
// of the project, plus one task to milestone link per task producing a deliverable
// of the project (spec "Milestone links": that is how a GanttProject user draws
// one).
//
// A dependency reaching another project is left out, and so is a deliverable link
// to a milestone outside the plan: the encoder could not write either (it hangs a
// <depend> off a row of the file), so reporting one as removed on the way back in
// would be a change nobody made.
func readPlanDeps(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID, tasks []planTaskRow, live map[string]bool) ([]PlanDep, error) {
	rows, err := ex.Query(ctx, `SELECT d.task_id, d.depends_on_id
		FROM project_task_dependency d
		JOIN project_task s ON s.id = d.task_id AND s.tenant_id = d.tenant_id
			AND s.deleted_at IS NULL AND s.project_id = $2
		JOIN project_task p ON p.id = d.depends_on_id AND p.tenant_id = d.tenant_id
			AND p.deleted_at IS NULL AND p.project_id = $2
		WHERE d.tenant_id = $1 AND d.project_id = $2 AND d.deleted_at IS NULL
		ORDER BY d.task_id, d.depends_on_id`, tenant, pid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PlanDep
	for rows.Next() {
		var task, dependsOn uuid.UUID
		if err := rows.Scan(&task, &dependsOn); err != nil {
			return nil, err
		}
		// EERP only knows finish-to-start, and the column that would hold a lag does
		// not exist, so every row is the file's plain FS dependency.
		out = append(out, PlanDep{Pred: dependsOn.String(), Succ: task.String(), Type: DepFS})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, task := range tasks {
		if task.milestoneID == nil {
			continue
		}
		succ := milestoneRefPrefix + task.milestoneID.String()
		if !live[succ] {
			continue
		}
		out = append(out, PlanDep{Pred: task.id.String(), Succ: succ, Type: DepFS})
	}
	return out, nil
}

// readPlanAssignments reads the task's people: the email is how a file names them,
// the label is what the partner sees next to it. A link whose user row is gone, or
// is a website visitor rather than staff, is not an assignment: there is no email
// for the file to carry, and the import's users map holds staff only.
func readPlanAssignments(ctx context.Context, ex orm.Executor, tenant, pid uuid.UUID) ([]PlanAssign, error) {
	rows, err := ex.Query(ctx, `SELECT l.task_id, u.email, u.display_name, u.name, u.surname
		FROM project_task_user l
		JOIN users u ON u.id = l.user_id AND u.tenant_id = l.tenant_id
			AND u.deleted_at IS NULL AND u.kind <> 'website'
		WHERE l.tenant_id = $1 AND l.project_id = $2 AND l.deleted_at IS NULL
		ORDER BY l.task_id, u.email, l.id`, tenant, pid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PlanAssign
	for rows.Next() {
		var (
			task                              uuid.UUID
			email, displayName, name, surname string
		)
		if err := rows.Scan(&task, &email, &displayName, &name, &surname); err != nil {
			return nil, err
		}
		out = append(out, PlanAssign{Task: task.String(), Email: email, Name: planUserName(displayName, name, surname, email)})
	}
	return out, rows.Err()
}

// planUserName is the label GanttProject shows for a person: the name the tenant
// chose, else the two name parts, else the email itself.
func planUserName(displayName, name, surname, email string) string {
	if n := strings.TrimSpace(displayName); n != "" {
		return n
	}
	if n := strings.Join(strings.Fields(name+" "+surname), " "); n != "" {
		return n
	}
	return email
}

// ── The file's terms ─────────────────────────────────────────────────────────

// planDates turns a task's two date columns into the file's start day and
// working-day duration.
//
// Both set is the pair the manager typed, and the duration is the count of days
// the file's calendar works between them (a deadline on a Saturday therefore comes
// back as the duration that ends on the Friday, which is what re-importing it
// without a change means). One of the two stands for both: EERP lets a task hold
// only a start or only a deadline, and the export must not invent a span for it.
// Neither is the placeholder, with the row flagged so the wizard can say "was
// unscheduled" if the partner moves it.
func planDates(start, deadline *time.Time, fallback time.Time, w Weekend) (time.Time, int, bool) {
	switch {
	case start != nil && deadline != nil:
		return day(*start), workdaysBetween(*start, *deadline, w), false
	case start != nil:
		return day(*start), 1, false
	case deadline != nil:
		return day(*deadline), 1, false
	default:
		return fallback, 1, true
	}
}

// placeholderDay is the deterministic day an undated row sits on for the exchange:
// the project's own start, else the day the row was created. The same rule at
// export and at import is what keeps an untouched file from reporting a date change
// on a task EERP has no dates for, so both sides must reach it the same way.
func placeholderDay(projectStart *time.Time, createdAt time.Time) time.Time {
	if projectStart != nil {
		return day(*projectStart)
	}
	return day(createdAt)
}

// wbsParts is a wbs_number split into its numbers, so tasks sort by position and
// not by text (2.10 after 2.9). A part that is not a number is 0, which keeps a
// row the triggers never numbered at the front of its siblings rather than losing
// it: wbs_number is trigger-maintained (migrate.go) and validate.go refuses a typed
// one that is not dotted positions, so this is the shape of a corrupt row, not of a
// live one.
func wbsParts(code *string) []int {
	if code == nil {
		return nil
	}
	parts := strings.Split(*code, ".")
	out := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	return out
}

// byWbs is the file's order over the project's rows: dotted position, and the id
// as the last word so the order does not depend on what the database happened to
// return first.
func byWbs(a, b planTaskRow) int {
	if n := slices.Compare(a.wbs, b.wbs); n != 0 {
		return n
	}
	return strings.Compare(a.id.String(), b.id.String())
}

// ── The base ─────────────────────────────────────────────────────────────────

// planHash is the base a preview returns and apply refuses a stale one on: hex
// sha256 of the plan in a canonical form, so the same project state always hashes
// the same, and any change the diff could report moves it.
//
// The canonical form is not Plan marshalled as it is. Its slices are sorted (the
// contract on Plan.Deps says the order of the dependencies means nothing, and the
// loader's order is a read order), its days are written as dates rather than as
// timestamps, and its one float is written by strconv: encoding/json refuses a NaN,
// and a Postgres double precision column can hold one, which a staleness check must
// survive rather than fail on.
func planHash(p Plan) string {
	sum := sha256.Sum256([]byte(canonicalJSON(p)))
	return hex.EncodeToString(sum[:])
}

// canonicalPlan is what planHash hashes: the fields that make the schedule, in a
// field order Go's encoder writes as declared, with nothing left to vary between
// two reads of one state.
type canonicalPlan struct {
	Name        string            `json:"name"`
	Weekend     [7]bool           `json:"weekend"`
	HasHolidays bool              `json:"has_holidays"`
	Tasks       []canonicalTask   `json:"tasks"`
	Deps        []canonicalDep    `json:"deps"`
	Assignments []canonicalAssign `json:"assignments"`
}

type canonicalTask struct {
	Ref          string `json:"ref"`
	FileID       string `json:"file_id"`
	Name         string `json:"name"`
	Parent       string `json:"parent"`
	Start        string `json:"start"`
	Duration     int    `json:"duration"`
	PlannedHours string `json:"planned_hours"`
	Complete     int    `json:"complete"`
	Milestone    bool   `json:"milestone"`
	Undated      bool   `json:"undated"`
	HasChildren  bool   `json:"has_children"`
}

type canonicalDep struct {
	Pred string `json:"pred"`
	Succ string `json:"succ"`
	Type int    `json:"type"`
	Lag  int    `json:"lag"`
}

type canonicalAssign struct {
	Task  string `json:"task"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func canonicalJSON(p Plan) string {
	c := canonicalPlan{Name: p.Name, Weekend: p.Weekend, HasHolidays: p.HasHolidays}
	// Sorted copies, never in place: the caller's plan keeps the order it was read
	// in, which is the file order the diff lays its rows out by. Stable, because two
	// rows can share one Key (a copy-pasted eerp_id) and a hash that moved between
	// two reads of one project would refuse a preview for nothing.
	tasks := slices.Clone(p.Tasks)
	slices.SortStableFunc(tasks, func(a, b PlanTask) int { return strings.Compare(a.Key(), b.Key()) })
	for _, task := range tasks {
		c.Tasks = append(c.Tasks, canonicalTask{
			Ref: task.Ref, FileID: task.FileID, Name: task.Name, Parent: task.Parent,
			Start: day(task.Start).Format("2006-01-02"), Duration: task.Duration,
			PlannedHours: strconv.FormatFloat(task.PlannedHours, 'f', -1, 64),
			Complete:     task.Complete, Milestone: task.Milestone,
			Undated: task.Undated, HasChildren: task.HasChildren,
		})
	}
	deps := slices.Clone(p.Deps)
	slices.SortStableFunc(deps, func(a, b PlanDep) int {
		if n := strings.Compare(a.Pred, b.Pred); n != 0 {
			return n
		}
		if n := strings.Compare(a.Succ, b.Succ); n != 0 {
			return n
		}
		if a.Type != b.Type {
			return int(a.Type) - int(b.Type)
		}
		return a.Lag - b.Lag
	})
	for _, dep := range deps {
		c.Deps = append(c.Deps, canonicalDep{Pred: dep.Pred, Succ: dep.Succ, Type: int(dep.Type), Lag: dep.Lag})
	}
	assigns := slices.Clone(p.Assignments)
	slices.SortStableFunc(assigns, func(a, b PlanAssign) int {
		if n := strings.Compare(a.Task, b.Task); n != 0 {
			return n
		}
		if n := strings.Compare(a.Email, b.Email); n != 0 {
			return n
		}
		return strings.Compare(a.Name, b.Name)
	})
	for _, assign := range assigns {
		c.Assignments = append(c.Assignments, canonicalAssign{Task: assign.Task, Email: assign.Email, Name: assign.Name})
	}

	// No error is possible: every field is a string, a bool or an int, and the one
	// float was rendered by strconv before it got here (a Postgres double precision
	// can hold a NaN, which encoding/json refuses). Should that ever change, the
	// fallback keeps the hash a function of the plan rather than an empty answer.
	out, err := json.Marshal(c)
	if err != nil {
		return fmt.Sprintf("%v", c)
	}
	return string(out)
}
