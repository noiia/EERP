package project

import (
	"context"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The loader's fixtures are built with the scope_test.go helpers, so the rows
// carry the triggers' real wbs_number and closed values rather than hand written
// ones: the loader's contract is about what the database holds.

// exDate parses a whole-day date the way the exchange columns store them (UTC
// midnight). "" is the NULL of the two date columns, so a fixture can leave one
// unset without a second helper.
func exDate(ymd string) any {
	if ymd == "" {
		return nil
	}
	d, err := time.Parse("2006-01-02", ymd)
	if err != nil {
		panic("exchange_load_test: bad date " + ymd)
	}
	return d
}

// exTaskDates pins a task's date_start and deadline; "" leaves the column NULL.
func exTaskDates(f *fixture, task uuid.UUID, start, deadline string) {
	f.t.Helper()
	f.exec(`UPDATE project_task SET date_start = $2, deadline = $3 WHERE id = $1`, task, exDate(start), exDate(deadline))
}

// exMilestoneDeadline pins a milestone's deadline; "" leaves it NULL.
func exMilestoneDeadline(f *fixture, milestone uuid.UUID, deadline string) {
	f.t.Helper()
	f.exec(`UPDATE project_milestone SET deadline = $2 WHERE id = $1`, milestone, exDate(deadline))
}

// exTaskName and exMilestoneName name a row, which the fixture helpers do not:
// they seed 'T' and 'M'.
func exTaskName(f *fixture, task uuid.UUID, name string) {
	f.t.Helper()
	f.exec(`UPDATE project_task SET name = $2 WHERE id = $1`, task, name)
}

func exMilestoneName(f *fixture, milestone uuid.UUID, name string) {
	f.t.Helper()
	f.exec(`UPDATE project_milestone SET name = $2 WHERE id = $1`, milestone, name)
}

// exStaff seeds a live staff user with the three profile fields the loader's
// display name rule reads, in the order it prefers them.
func exStaff(f *fixture, email, displayName, name, surname string) uuid.UUID {
	f.t.Helper()
	id := f.id(`INSERT INTO users (tenant_id, email, kind, display_name, name, surname)
		VALUES ($1, $2, '', $3, $4, $5) RETURNING id`, f.tenant, email, displayName, name, surname)
	f.t.Cleanup(func() {
		_, _ = f.app.DB.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// exLoad loads the project as a plan, the way the preview does (no HTTP caller
// involved: loadPlan is plain SQL, tenant-pinned by argument).
func exLoad(t *testing.T, f *fixture, pid uuid.UUID, w Weekend) Plan {
	t.Helper()
	p, err := loadPlan(context.Background(), f.app.DB, f.tenant, pid, w)
	if err != nil {
		t.Fatalf("loadPlan: %v", err)
	}
	return p
}

// exKeys is the plan's task order, which is what the loader owes the diff.
func exKeys(p Plan) []string {
	out := make([]string, 0, len(p.Tasks))
	for _, task := range p.Tasks {
		out = append(out, task.Key())
	}
	return out
}

// exHasDep reports whether p holds dep, comparing as a set: Plan.Deps order means
// nothing (see the contract on the field), so no loader assertion may depend on it.
func exHasDep(p Plan, want PlanDep) bool {
	return slices.Contains(p.Deps, want)
}

// exDepCount is how many of p's dependencies hold a key, whatever their other end.
func exDepCount(p Plan, key string) int {
	n := 0
	for _, dep := range p.Deps {
		if dep.Pred == key || dep.Succ == key {
			n++
		}
	}
	return n
}

// exPlanTask finds a row by Key, failing the test when it is absent.
func exPlanTask(t *testing.T, p Plan, key string) PlanTask {
	t.Helper()
	for _, task := range p.Tasks {
		if task.Key() == key {
			return task
		}
	}
	t.Fatalf("plan has no task %s, it has %v", key, exKeys(p))
	return PlanTask{}
}

func TestLoadPlan(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	f.exec(`UPDATE project SET date_start = $2 WHERE id = $1`, p, exDate("2026-01-05"))

	// 1 Design (undated: the placeholder), 1.1 Draft (Mon to Fri), 1.2 Review
	// (undated), 2 Ship (closed).
	parent := f.task(p, nil, nil)
	exTaskName(f, parent, "Design")
	draft := f.task(p, &parent, nil)
	exTaskName(f, draft, "Draft")
	exTaskDates(f, draft, "2026-01-05", "2026-01-09") // a Monday to a Friday
	review := f.task(p, &parent, nil)
	exTaskName(f, review, "Review")
	ship := f.task(p, nil, nil)
	exTaskName(f, ship, "Ship")
	f.moveTo(ship, f.stage(p, "Done")) // the trigger mirrors closed

	// Deliverables: Ship produces Release (a deadline), and a milestone with no
	// deadline of its own shows the placeholder too.
	release := f.milestone(p)
	exMilestoneName(f, release, "Release")
	exMilestoneDeadline(f, release, "2026-02-13")
	f.exec(`UPDATE project_task SET milestone_id = $2 WHERE id = $1`, ship, release)
	kickoff := f.milestone(p)
	exMilestoneName(f, kickoff, "Kickoff")

	// One dependency inside the project, one reaching another project.
	f.dependency(p, ship, parent)
	elsewhere := f.project(mgr, "everyone")
	foreign := f.task(elsewhere, nil, nil)
	f.dependency(p, draft, foreign)

	// One assignee, with an email and a display name.
	ann := exStaff(f, "ann@x.test", "Ann Lee", "Anne", "Lees")
	f.assign(p, draft, ann)

	p1 := exLoad(t, f, p, DefaultWeekend)

	t.Run("the order is wbs order, with the milestones last", func(t *testing.T) {
		want := []string{
			parent.String(), draft.String(), review.String(), ship.String(),
			"milestone:" + release.String(), "milestone:" + kickoff.String(),
		}
		if got := exKeys(p1); !slices.Equal(got, want) {
			t.Errorf("task order = %v, want %v", got, want)
		}
		if p1.Name != "" {
			t.Errorf("Name = %q, want empty: the project's name is exportPlan's to add", p1.Name)
		}
		if p1.Weekend != DefaultWeekend {
			t.Errorf("Weekend = %v, want the mask loadPlan was handed", p1.Weekend)
		}
	})

	t.Run("a task carries its identity, its parent and its summary flag", func(t *testing.T) {
		got := exPlanTask(t, p1, parent.String())
		if got.Ref != parent.String() || got.FileID != "" {
			t.Errorf("parent = %+v, want Ref %s and no FileID", got, parent)
		}
		if got.Name != "Design" || got.Parent != "" || !got.HasChildren {
			t.Errorf("parent = %+v, want the name Design at the top level with children", got)
		}
		child := exPlanTask(t, p1, draft.String())
		if child.Parent != parent.String() {
			t.Errorf("Draft Parent = %q, want %q (the parent's Key)", child.Parent, parent)
		}
		if child.HasChildren {
			t.Errorf("Draft HasChildren = true, want false: it has no live subtask")
		}
	})

	t.Run("dates become a start and a working-day duration", func(t *testing.T) {
		got := exPlanTask(t, p1, draft.String())
		if want := exDate("2026-01-05").(time.Time); !got.Start.Equal(want) {
			t.Errorf("Draft Start = %s, want %s", got.Start.Format(time.RFC3339), want.Format(time.RFC3339))
		}
		if got.Duration != 5 {
			t.Errorf("Draft Duration = %d, want 5 (Monday to Friday of one week)", got.Duration)
		}
		if got.Undated {
			t.Errorf("Draft Undated = true, want false: both dates are set")
		}
	})

	t.Run("an undated task gets the deterministic placeholder", func(t *testing.T) {
		got := exPlanTask(t, p1, review.String())
		if !got.Undated {
			t.Errorf("Review Undated = false, want true: neither date is set")
		}
		if want := exDate("2026-01-05").(time.Time); !got.Start.Equal(want) {
			t.Errorf("Review Start = %s, want the project's date_start %s", got.Start.Format(time.RFC3339), want.Format(time.RFC3339))
		}
		if got.Duration != 1 {
			t.Errorf("Review Duration = %d, want the placeholder 1", got.Duration)
		}
		if parentTask := exPlanTask(t, p1, parent.String()); !parentTask.Undated {
			t.Errorf("Design Undated = false, want true: the parent holds no date either")
		}
	})

	t.Run("completion is 100 only when the task is closed", func(t *testing.T) {
		if got := exPlanTask(t, p1, ship.String()).Complete; got != 100 {
			t.Errorf("Ship Complete = %d, want 100 (its stage is closed)", got)
		}
		if got := exPlanTask(t, p1, draft.String()).Complete; got != 0 {
			t.Errorf("Draft Complete = %d, want 0", got)
		}
	})

	t.Run("a milestone comes after the tasks, on its deadline", func(t *testing.T) {
		got := exPlanTask(t, p1, "milestone:"+release.String())
		if !got.Milestone || got.Ref != "milestone:"+release.String() {
			t.Fatalf("Release = %+v, want a milestone keyed milestone:%s", got, release)
		}
		if got.Duration != 0 {
			t.Errorf("Release Duration = %d, want 0", got.Duration)
		}
		if want := exDate("2026-02-13").(time.Time); !got.Start.Equal(want) {
			t.Errorf("Release Start = %s, want its deadline %s", got.Start.Format(time.RFC3339), want.Format(time.RFC3339))
		}
		if got.PlannedHours != 0 || got.Complete != 0 {
			t.Errorf("Release = %+v, want no planned hours and no completion: EERP holds neither for a milestone", got)
		}

		free := exPlanTask(t, p1, "milestone:"+kickoff.String())
		if !free.Undated {
			t.Errorf("Kickoff Undated = false, want true: it has no deadline")
		}
		if want := exDate("2026-01-05").(time.Time); !free.Start.Equal(want) {
			t.Errorf("Kickoff Start = %s, want the project's date_start %s", free.Start.Format(time.RFC3339), want.Format(time.RFC3339))
		}
		if free.Duration != 0 {
			t.Errorf("Kickoff Duration = %d, want 0: the placeholder is 1 for a task, 0 for a milestone", free.Duration)
		}
	})

	t.Run("dependencies keep both ends of the project, and a deliverable is one", func(t *testing.T) {
		if len(p1.Deps) != 2 {
			t.Errorf("Deps = %+v, want the in-project dependency and the milestone link", p1.Deps)
		}
		if !exHasDep(p1, PlanDep{Pred: parent.String(), Succ: ship.String(), Type: DepFS, Lag: 0}) {
			t.Errorf("Deps = %+v, want %s -> %s (DepFS, no lag)", p1.Deps, parent, ship)
		}
		if !exHasDep(p1, PlanDep{Pred: ship.String(), Succ: "milestone:" + release.String(), Type: DepFS, Lag: 0}) {
			t.Errorf("Deps = %+v, want the deliverable link %s -> milestone:%s", p1.Deps, ship, release)
		}
		if n := exDepCount(p1, foreign.String()); n != 0 {
			t.Errorf("%d dependencies name the task of another project, want 0: they are never exported", n)
		}
	})

	t.Run("an assignee is the email and the label the partner sees", func(t *testing.T) {
		want := PlanAssign{Task: draft.String(), Email: "ann@x.test", Name: "Ann Lee"}
		if !slices.Equal(p1.Assignments, []PlanAssign{want}) {
			t.Errorf("Assignments = %+v, want [%+v]", p1.Assignments, want)
		}
	})

	t.Run("a deleted row is not in the plan", func(t *testing.T) {
		f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, review)
		f.exec(`UPDATE project_milestone SET deleted_at = now() WHERE id = $1`, kickoff)
		f.exec(`UPDATE project_task_user SET deleted_at = now() WHERE task_id = $1 AND user_id = $2`, draft, ann)
		after := exLoad(t, f, p, DefaultWeekend)
		for _, key := range []string{review.String(), "milestone:" + kickoff.String()} {
			for _, task := range after.Tasks {
				if task.Key() == key {
					t.Errorf("the plan still holds the deleted row %s", key)
				}
			}
		}
		if len(after.Assignments) != 0 {
			t.Errorf("Assignments = %+v, want none: the link is deleted", after.Assignments)
		}
	})
}

// The parent keeps its summary flag as long as one live subtask is left, which is
// what the loader derives rather than reads from subtask_count.
func TestLoadPlan_HasChildrenIsLiveSubtasks(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	parent := f.task(p, nil, nil)
	a := f.task(p, &parent, nil)
	f.task(p, &parent, nil)

	if !exPlanTask(t, exLoad(t, f, p, DefaultWeekend), parent.String()).HasChildren {
		t.Errorf("HasChildren = false with two live subtasks, want true")
	}
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, a)
	if !exPlanTask(t, exLoad(t, f, p, DefaultWeekend), parent.String()).HasChildren {
		t.Errorf("HasChildren = false with one live subtask left, want true")
	}
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE project_id = $1 AND parent_id = $2`, p, parent)
	if exPlanTask(t, exLoad(t, f, p, DefaultWeekend), parent.String()).HasChildren {
		t.Errorf("HasChildren = true with no live subtask, want false: the flag is what the .gan summary shape needs")
	}
}

// An assignee whose user row is gone is not an assignment: the file cannot name a
// person EERP has no email for. A website visitor is not an assignee either, the
// same staff-only rule the import's users map applies.
func TestLoadPlan_AssigneeWithoutUser(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	task := f.task(p, nil, nil)
	f.assign(p, task, uuid.New())
	f.assign(p, task, uuid.New())
	visitor := f.user("website")
	f.assign(p, task, visitor)
	staff := exStaff(f, "real@x.test", "Real Person", "", "")
	f.assign(p, task, staff)

	got := exLoad(t, f, p, DefaultWeekend).Assignments
	want := []PlanAssign{{Task: task.String(), Email: "real@x.test", Name: "Real Person"}}
	if !slices.Equal(got, want) {
		t.Errorf("Assignments = %+v, want %+v: only the live staff user is one", got, want)
	}
}

// The display name the partner sees is display_name, else name surname, else the
// email: the three shapes the users table actually holds.
func TestLoadPlan_DisplayName(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	task := f.task(p, nil, nil)
	named := exStaff(f, "named@x.test", "The Count", "Num", "Ber")
	parts := exStaff(f, "parts@x.test", "", "Jean", "Dupont")
	bare := exStaff(f, "bare@x.test", "", "", "")
	for _, u := range []uuid.UUID{named, parts, bare} {
		f.assign(p, task, u)
	}

	got := exLoad(t, f, p, DefaultWeekend).Assignments
	want := map[string]string{
		"named@x.test": "The Count",
		"parts@x.test": "Jean Dupont",
		"bare@x.test":  "bare@x.test",
	}
	if len(got) != len(want) {
		t.Fatalf("Assignments = %+v, want %d rows", got, len(want))
	}
	for _, a := range got {
		if a.Task != task.String() {
			t.Errorf("assignment on %q, want %s", a.Task, task)
		}
		if label, ok := want[a.Email]; !ok {
			t.Errorf("unexpected assignment for %q", a.Email)
		} else if a.Name != label {
			t.Errorf("%s: Name = %q, want %q", a.Email, a.Name, label)
		}
	}
}

// The other half of the placeholder: with no project date_start to fall back on,
// an undated row sits on the day it was created. Backdated on purpose: a placeholder
// reading the clock would pass a test written on the same day as the rows, and the
// round trip depends on the day being the row's own.
func TestLoadPlan_UndatedPlaceholderIsCreatedAt(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone") // no date_start
	task := f.task(p, nil, nil)
	gate := f.milestone(p)
	f.exec(`UPDATE project_task SET created_at = $2 WHERE id = $1`, task, time.Date(2019, 3, 4, 10, 0, 0, 0, time.UTC))
	f.exec(`UPDATE project_milestone SET created_at = $2 WHERE id = $1`, gate, time.Date(2019, 6, 30, 22, 0, 0, 0, time.UTC))

	plan := exLoad(t, f, p, DefaultWeekend)
	var created, gateCreated time.Time
	if err := f.app.DB.QueryRow(context.Background(),
		`SELECT created_at FROM project_task WHERE id = $1`, task).Scan(&created); err != nil {
		t.Fatal(err)
	}
	if err := f.app.DB.QueryRow(context.Background(),
		`SELECT created_at FROM project_milestone WHERE id = $1`, gate).Scan(&gateCreated); err != nil {
		t.Fatal(err)
	}

	got := exPlanTask(t, plan, task.String())
	if !got.Undated || !got.Start.Equal(day(created)) || got.Duration != 1 {
		t.Errorf("task = %+v, want the placeholder on %s with duration 1", got, day(created).Format("2006-01-02"))
	}
	milestone := exPlanTask(t, plan, "milestone:"+gate.String())
	if !milestone.Undated || !milestone.Start.Equal(day(gateCreated)) || milestone.Duration != 0 {
		t.Errorf("milestone = %+v, want the placeholder on %s with duration 0", milestone, day(gateCreated).Format("2006-01-02"))
	}
}

// One date of the pair stands for both: the export must not invent a duration for
// a task whose manager only ever filled one of them in.
func TestLoadPlan_OneDateOnly(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	f.exec(`UPDATE project SET date_start = $2 WHERE id = $1`, p, exDate("2026-03-02"))

	onlyStart := f.task(p, nil, nil)
	exTaskDates(f, onlyStart, "2026-01-05", "")
	onlyDeadline := f.task(p, nil, nil)
	exTaskDates(f, onlyDeadline, "", "2026-01-09")

	plan := exLoad(t, f, p, DefaultWeekend)
	start := exPlanTask(t, plan, onlyStart.String())
	if start.Undated || !start.Start.Equal(exDate("2026-01-05").(time.Time)) || start.Duration != 1 {
		t.Errorf("start only = %+v, want the start's own day, duration 1, not undated", start)
	}
	deadline := exPlanTask(t, plan, onlyDeadline.String())
	if deadline.Undated || !deadline.Start.Equal(exDate("2026-01-09").(time.Time)) || deadline.Duration != 1 {
		t.Errorf("deadline only = %+v, want the deadline's own day, duration 1, not undated", deadline)
	}
}

// A duration is counted on the calendar the file uses, not on EERP's default: the
// preview loads the current plan with the file's weekend precisely so a partner's
// six-day week does not read as a change on every task.
func TestLoadPlan_WeekendOfTheCaller(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	task := f.task(p, nil, nil)
	exTaskDates(f, task, "2026-01-05", "2026-01-10") // Monday to Saturday

	five := exPlanTask(t, exLoad(t, f, p, DefaultWeekend), task.String())
	if five.Duration != 5 {
		t.Errorf("Duration on the default week = %d, want 5 (Saturday off)", five.Duration)
	}
	sixDay := Weekend{time.Sunday: true}
	six := exPlanTask(t, exLoad(t, f, p, sixDay), task.String())
	if six.Duration != 6 {
		t.Errorf("Duration with Saturday worked = %d, want 6: the mask is the caller's", six.Duration)
	}
}

// A task whose milestone belongs to another project cannot happen through the
// form (taskRules pins it), but the loader must not hang a dependency on a
// milestone the plan does not hold: the encoder would drop it and the diff would
// then report a link EERP never exported as removed.
func TestLoadPlan_MilestoneOfAnotherProject(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	elsewhere := f.project(mgr, "everyone")
	task := f.task(p, nil, nil)
	foreign := f.milestone(elsewhere)
	f.exec(`UPDATE project_task SET milestone_id = $2 WHERE id = $1`, task, foreign)

	plan := exLoad(t, f, p, DefaultWeekend)
	if len(plan.Deps) != 0 {
		t.Errorf("Deps = %+v, want none: the milestone is not of this project", plan.Deps)
	}
	if n := exDepCount(plan, "milestone:"+foreign.String()); n != 0 {
		t.Errorf("%d dependencies name a milestone of another project, want 0", n)
	}
}

// A dependency whose far end is a deleted task is not a dependency of the plan.
func TestLoadPlan_DeletedDependencyEnd(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	a, b := f.task(p, nil, nil), f.task(p, nil, nil)
	f.dependency(p, a, b)
	if got := exLoad(t, f, p, DefaultWeekend); len(got.Deps) != 1 {
		t.Fatalf("Deps = %+v, want the one live dependency", got.Deps)
	}
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, b)
	if got := exLoad(t, f, p, DefaultWeekend); len(got.Deps) != 0 {
		t.Errorf("Deps = %+v, want none: one end is deleted", got.Deps)
	}
	f.exec(`UPDATE project_task_dependency SET deleted_at = now() WHERE task_id = $1`, a)
	if got := exLoad(t, f, p, DefaultWeekend); len(got.Deps) != 0 {
		t.Errorf("Deps = %+v, want none: the row is deleted", got.Deps)
	}
}

func TestLoadPlan_UnknownProject(t *testing.T) {
	f := newFixture(t)
	if _, err := loadPlan(context.Background(), f.app.DB, f.tenant, uuid.New(), DefaultWeekend); err == nil {
		t.Error("loadPlan of a project this tenant has no row for = nil, want an error")
	}
}

// A dependency of the plan has both ends in the project, which is three filters and
// not one: the row's own project, and each of its two tasks. A dependency reaching
// another project is never exported, so it must never be reported as removed on the
// way back in either.
func TestLoadPlan_OnlyRowsOfTheProject(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	elsewhere := f.project(mgr, "everyone")
	mine, alsoMine, third := f.task(p, nil, nil), f.task(p, nil, nil), f.task(p, nil, nil)
	theirs := f.task(elsewhere, nil, nil)

	dep := func(project, task, dependsOn uuid.UUID) {
		f.exec(`INSERT INTO project_task_dependency (tenant_id, project_id, task_id, depends_on_id)
			VALUES ($1, $2, $3, $4)`, f.tenant, project, task, dependsOn)
	}
	dep(p, mine, theirs)        // the far end is of another project
	dep(p, theirs, alsoMine)    // the near end is
	dep(elsewhere, mine, third) // the row itself belongs to the other project

	if got := exLoad(t, f, p, DefaultWeekend); len(got.Deps) != 0 {
		t.Errorf("Deps = %+v, want none: none of the three has both ends in the project", got.Deps)
	}
	dep(p, mine, alsoMine)
	if got := exLoad(t, f, p, DefaultWeekend); len(got.Deps) != 1 {
		t.Errorf("Deps = %+v, want the one dependency of the project", got.Deps)
	}
}

// The order the loader hands out is the file's: a parent before its children, each
// child after its elder siblings. It is a sort of the dotted parts, not a text
// sort, which is where a tenth task would otherwise jump back to second place.
func TestLoadPlan_WbsOrderIsNumeric(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")

	var top []uuid.UUID
	for i := 0; i < 3; i++ {
		top = append(top, f.task(p, nil, nil))
	}
	var kids []uuid.UUID
	for i := 0; i < 12; i++ {
		kids = append(kids, f.task(p, &top[1], nil))
	}

	order := exKeys(exLoad(t, f, p, DefaultWeekend))
	want := []string{top[0].String(), top[1].String()}
	for _, kid := range kids { // 2.1 to 2.12, not 2.1, 2.10, 2.11, 2.2
		want = append(want, kid.String())
	}
	want = append(want, top[2].String())
	if !slices.Equal(order, want) {
		t.Errorf("task order = %v, want %v (2.10 sits after 2.9)", order, want)
	}
}

// planHash is the base apply refuses a stale preview on, so it must answer the
// project's state alone: the same rows hash the same twice, and any real change
// moves it.
func TestPlanHash_Stable(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	f.exec(`UPDATE project SET date_start = $2 WHERE id = $1`, p, exDate("2026-01-05"))
	parent := f.task(p, nil, nil)
	child := f.task(p, &parent, nil)
	exTaskDates(f, child, "2026-01-05", "2026-01-09")
	other := f.task(p, nil, nil)
	f.dependency(p, other, parent)
	gate := f.milestone(p)
	f.exec(`UPDATE project_task SET milestone_id = $2 WHERE id = $1`, other, gate)
	ann := exStaff(f, "ann@x.test", "Ann Lee", "", "")
	f.assign(p, child, ann)

	before := planHash(exLoad(t, f, p, DefaultWeekend))
	after := planHash(exLoad(t, f, p, DefaultWeekend))
	if before != after {
		t.Errorf("the same project hashed %s then %s, want one base for one state", before, after)
	}
	if len(before) != 64 || strings.ToLower(before) != before {
		t.Errorf("planHash = %q, want 64 lowercase hex characters (sha256)", before)
	}

	// The slice order of Deps means nothing (the contract on the field), so it
	// must not move the base either.
	p1 := exLoad(t, f, p, DefaultWeekend)
	reordered := p1
	reordered.Deps = slices.Clone(p1.Deps)
	slices.Reverse(reordered.Deps)
	if planHash(reordered) != planHash(p1) {
		t.Errorf("reversing Deps changed the hash, want it order-blind")
	}
	withDup := p1
	withDup.Assignments = append(slices.Clone(p1.Assignments), p1.Assignments[0])
	if planHash(withDup) == planHash(p1) {
		t.Errorf("a second identical assignment left the hash alone, want the multiset compared")
	}

	exTaskDates(f, child, "2026-01-05", "2026-01-16") // one deadline moved
	moved := planHash(exLoad(t, f, p, DefaultWeekend))
	if moved == before {
		t.Errorf("a deadline update left the hash at %s, want a new base so apply refuses", moved)
	}

	f.exec(`UPDATE project_task SET name = 'Renamed' WHERE id = $1`, parent)
	if planHash(exLoad(t, f, p, DefaultWeekend)) == moved {
		t.Error("a rename left the hash alone, want a new base")
	}
}

// The base describes the schedule, not the calendar mask the caller happened to
// pass, nor the project's label: the two are the same project's state.
func TestPlanHash_WeekendIsPartOfThePlan(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "everyone")
	f.task(p, nil, nil)

	defaultWeek := planHash(exLoad(t, f, p, DefaultWeekend))
	if planHash(exLoad(t, f, p, Weekend{time.Sunday: true})) == defaultWeek {
		t.Error("a different calendar left the hash alone: the plan's Weekend is hashed with it")
	}
}

// A Postgres double precision column can hold a NaN, and encoding/json refuses one
// outright: a staleness check that fails on a value a row happens to carry is worse
// than one that canonicalises it. The hours therefore reach the canonical form as
// text, so a NaN hashes, and still tells a real number apart from itself.
func TestPlanHash_HostileFloat(t *testing.T) {
	nan := Plan{Tasks: []PlanTask{{Ref: "11111111-1111-4111-8111-111111111111", PlannedHours: math.NaN()}}}
	same := Plan{Tasks: []PlanTask{{Ref: "11111111-1111-4111-8111-111111111111", PlannedHours: math.NaN()}}}
	zero := Plan{Tasks: []PlanTask{{Ref: "11111111-1111-4111-8111-111111111111", PlannedHours: 0}}}
	inf := Plan{Tasks: []PlanTask{{Ref: "11111111-1111-4111-8111-111111111111", PlannedHours: math.Inf(1)}}}

	if planHash(nan) != planHash(same) {
		t.Error("two plans holding one NaN hashed differently, want one base for one state")
	}
	if planHash(nan) == planHash(zero) || planHash(inf) == planHash(zero) || planHash(nan) == planHash(inf) {
		t.Error("a NaN or an infinity hashed as 0 planned hours, want the value kept apart")
	}
}
