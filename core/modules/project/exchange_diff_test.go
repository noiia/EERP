package project

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The diff is pure: no database, no file. Every test here builds two Plans in
// code, current and file's, and reads back the rows diffPlans produces. The
// values a row carries are compared as JSON, because that is the shape the
// wizard renders and the shape Task 7 converts back to EERP form.
//
// 2026-03-02 is a Monday, so the week runs Mon 2nd to Fri 6th with Sat 7th and
// Sun 8th off, and the next worked day is Mon 9th: the weekend cases below are
// read against DefaultWeekend.

const (
	dfxMon  = "2026-03-02"
	dfxTue  = "2026-03-03"
	dfxWed  = "2026-03-04"
	dfxThu  = "2026-03-05"
	dfxFri  = "2026-03-06"
	dfxSat  = "2026-03-07"
	dfxMon2 = "2026-03-09"
)

// The identities one diff test's project holds: three tasks, a fourth the file
// dropped, a milestone, and a user.
var (
	dfxA     = uuid.MustParse("aaaaaaaa-0000-4000-8000-00000000000a")
	dfxB     = uuid.MustParse("bbbbbbbb-0000-4000-8000-00000000000b")
	dfxC     = uuid.MustParse("cccccccc-0000-4000-8000-00000000000c")
	dfxDrop  = uuid.MustParse("dddddddd-0000-4000-8000-00000000000d")
	dfxGate  = uuid.MustParse("eeeeeeee-0000-4000-8000-00000000000e")
	dfxGate2 = uuid.MustParse("eeeeeeee-0000-4000-8000-00000000000f")
	dfxAnn   = uuid.MustParse("ffffffff-0000-4000-8000-00000000000a")
	// Ids no project holds, for the foreign file.
	dfxForeignA = uuid.MustParse("11111111-1111-4111-8111-111111111111")
	dfxForeignB = uuid.MustParse("22222222-2222-4222-8222-222222222222")
	dfxForeignG = uuid.MustParse("33333333-3333-4333-8333-333333333333")
)

// dfxKey and dfxGateKey are the two identities a Plan carries for an EERP row.
func dfxKey(id uuid.UUID) string { return id.String() }

func dfxGateKey(id uuid.UUID) string { return milestoneRefPrefix + id.String() }

// dfxDay parses a test day. A literal that does not parse is a bug in the test,
// so it panics rather than needing a *testing.T in every plan builder.
func dfxDay(ymd string) time.Time {
	d, err := time.Parse("2006-01-02", ymd)
	if err != nil {
		panic("bad test day " + ymd + ": " + err.Error())
	}
	return d
}

// dfxTask is a task of a diff test's plan: ref is its EERP identity, parent a
// key, start a "2006-01-02" day, dur its duration in working days.
func dfxTask(ref, parent, name, start string, dur int) PlanTask {
	return PlanTask{Ref: ref, Parent: parent, Name: name, Start: day(dfxDay(start)), Duration: dur}
}

// dfxNew is a task the file added: no Ref, so its key is its own file id.
func dfxNew(fileID, parent, name, start string, dur int) PlanTask {
	t := dfxTask("", parent, name, start, dur)
	t.FileID = fileID
	return t
}

// dfxMilestone is a milestone: no duration, and no parent of its own (spec: they are
// exported at the top level, after the tasks).
func dfxMilestone(ref, name, start string) PlanTask {
	return PlanTask{Ref: ref, Name: name, Start: day(dfxDay(start)), Milestone: true}
}

// dfxNewMilestone is a milestone the file added.
func dfxNewMilestone(fileID, name, start string) PlanTask {
	g := dfxMilestone("", name, start)
	g.FileID = fileID
	return g
}

// dfxPlan assembles tasks into a plan on the default calendar, plus any
// dependencies and assignments given.
func dfxPlan(tasks []PlanTask, deps []PlanDep, assigns ...PlanAssign) Plan {
	return Plan{Weekend: DefaultWeekend, Tasks: tasks, Deps: deps, Assignments: assigns}
}

// dfxUsers is the staff map Task 8 builds: lower(email) to user id.
func dfxUsers() map[string]uuid.UUID {
	return map[string]uuid.UUID{"ann@x.com": dfxAnn}
}

// dfxKeys is the order the wizard would show the rows in.
func dfxKeys(changes []Change) []string {
	out := make([]string, len(changes))
	for i, c := range changes {
		out[i] = c.Key
	}
	return out
}

func dfxWantKeys(t *testing.T, changes []Change, want ...string) {
	t.Helper()
	got := dfxKeys(changes)
	if len(got) != len(want) || strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("rows = %s (%d), want %s (%d)", strings.Join(got, " "), len(got), strings.Join(want, " "), len(want))
	}
}

// dfxRow returns the one row with that key, failing when it is missing or twice.
func dfxRow(t *testing.T, changes []Change, key string) Change {
	t.Helper()
	var found *Change
	for i, c := range changes {
		if c.Key == key {
			if found != nil {
				t.Fatalf("row %s comes twice", key)
			}
			found = &changes[i]
		}
	}
	if found == nil {
		t.Fatalf("no row %s in %s", key, strings.Join(dfxKeys(changes), " "))
	}
	return *found
}

// dfxCount counts the rows of one kind.
func dfxCount(changes []Change, kind string) int {
	n := 0
	for _, c := range changes {
		if c.Kind == kind {
			n++
		}
	}
	return n
}

// dfxWantWarning fails unless a warning with that code names that task.
func dfxWantWarning(t *testing.T, warnings []Warning, code, task string) {
	t.Helper()
	for _, w := range warnings {
		if w.Code == code && w.Task == task {
			return
		}
	}
	t.Errorf("no %s warning for task %q in %+v", code, task, warnings)
}

func dfxWantNoWarning(t *testing.T, warnings []Warning, code string) {
	t.Helper()
	for _, w := range warnings {
		if w.Code == code {
			t.Errorf("unexpected %s warning: %+v", code, w)
		}
	}
}

func dfxWantEmpty(t *testing.T, changes []Change, warnings []Warning) {
	t.Helper()
	dfxWantNoRows(t, changes)
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
}

// dfxWantNoRows is for the cases where a warning is the whole point.
func dfxWantNoRows(t *testing.T, changes []Change) {
	t.Helper()
	if len(changes) != 0 {
		t.Errorf("rows = %s, want none", strings.Join(dfxKeys(changes), " "))
	}
}

// dfxWantNoChange is the round-trip assertion: two plans that mean the same thing
// produce neither a row nor a warning.
func dfxWantNoChange(t *testing.T, cur, file Plan, users map[string]uuid.UUID) {
	t.Helper()
	changes, warnings := diffPlans(cur, file, users)
	dfxWantEmpty(t, changes, warnings)
}

// dfxJSON renders a row's Before or After the way the wizard receives it.
func dfxJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %#v: %v", v, err)
	}
	return string(b)
}

func TestDiff_IdenticalIsEmpty(t *testing.T) {
	kA, kB, kC, kG := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC), dfxGateKey(dfxGate)
	// Everything the model can hold: a summary with children, a closed task,
	// hours, a milestone, a dependency, a milestone link and an assignment.
	plan := Plan{
		Name:    "Roadmap",
		Weekend: DefaultWeekend,
		Tasks: []PlanTask{
			{Ref: kA, Name: "Design", Start: day(dfxDay(dfxMon)), Duration: 5, HasChildren: true},
			{Ref: kB, Parent: kA, Name: "Draft", Start: day(dfxDay(dfxMon)), Duration: 3, PlannedHours: 4},
			{Ref: kC, Parent: kA, Name: "Review", Start: day(dfxDay(dfxWed)), Duration: 2, Complete: 100},
			{Ref: kG, Name: "Deliverable", Start: day(dfxDay(dfxSat)), Milestone: true},
		},
		Deps:        []PlanDep{{Pred: kA, Succ: kB}, {Pred: kC, Succ: kG}},
		Assignments: []PlanAssign{{Task: kB, Email: "ann@x.com", Name: "Ann"}},
	}
	dfxWantNoChange(t, plan, plan, dfxUsers())

	// An undated placeholder and an empty plan read the same way twice too.
	undated := dfxPlan([]PlanTask{{Ref: kA, Name: "Design", Start: day(dfxDay(dfxMon)), Duration: 1, Undated: true}}, nil)
	dfxWantNoChange(t, undated, undated, dfxUsers())
	dfxWantNoChange(t, Plan{Weekend: DefaultWeekend}, Plan{Weekend: DefaultWeekend}, nil)
}

// TestDiff_WeekendDeadlineStable is the round-trip case the spec calls out: an
// EERP deadline on a Saturday exports as some duration, and re-importing that
// same duration is not a change, even though converting it back lands on Friday.
func TestDiff_WeekendDeadlineStable(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 5)}, nil)

	t.Run("the same duration is no row", func(t *testing.T) {
		file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 5)}, nil)
		dfxWantNoChange(t, cur, file, nil)
	})

	// One more working day is a row, and its ends are the working days, not the
	// calendar days: five days from Monday end Friday, six end the next Monday.
	t.Run("the ends are working days", func(t *testing.T) {
		file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 6)}, nil)
		changes, warnings := diffPlans(cur, file, nil)
		dfxWantKeys(t, changes, "task:"+kA+":dates")
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		row := dfxRow(t, changes, "task:"+kA+":dates")
		if row.Kind != "update" || row.Field != "dates" {
			t.Errorf("row = %+v, want an update of dates", row)
		}
		if got, want := dfxJSON(t, row.Before), `{"start":"2026-03-02","end":"2026-03-06"}`; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.After), `{"start":"2026-03-02","end":"2026-03-09"}`; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
		if row.Task != "Design" {
			t.Errorf("task = %q, want Design", row.Task)
		}
	})

	// A deadline the file itself puts on a Saturday is stable too: the duration
	// is what is compared, never a day rebuilt from it.
	t.Run("a weekend deadline is not a change", func(t *testing.T) {
		both := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 6)}, nil)
		dfxWantNoChange(t, both, both, nil)
	})
}

// TestDiff_UndatedPlaceholderStable: a task EERP has no dates for exports with
// the deterministic placeholder. The file carrying that same placeholder back is
// not a change, even though the file's row is not marked undated.
func TestDiff_UndatedPlaceholderStable(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{{Ref: kA, Name: "Design", Start: day(dfxDay(dfxMon)), Duration: 1, Undated: true}}, nil)
	file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	dfxWantNoChange(t, cur, file, nil)
}

// TestDiff_UndatedMovedIsWasUnscheduled: once the partner moves such a task it
// gets real dates, and the row says so, because "before" is a placeholder EERP
// never chose.
func TestDiff_UndatedMovedIsWasUnscheduled(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{{Ref: kA, Name: "Design", Start: day(dfxDay(dfxMon)), Duration: 1, Undated: true}}, nil)
	file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxWed, 2)}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "task:"+kA+":dates")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	row := dfxRow(t, changes, "task:"+kA+":dates")
	if !row.WasUnscheduled {
		t.Errorf("row = %+v, want was_unscheduled", row)
	}
	if got, want := dfxJSON(t, row.Before), `{"start":"2026-03-02","end":"2026-03-02"}`; got != want {
		t.Errorf("before = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, row.After), `{"start":"2026-03-04","end":"2026-03-05"}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}

	// A dated task is never labelled that way.
	dated := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	rows, _ := diffPlans(dated, file, nil)
	row = dfxRow(t, rows, "task:"+kA+":dates")
	if row.WasUnscheduled {
		t.Errorf("row = %+v, want no was_unscheduled on a dated task", row)
	}
}

// TestDiff_SummaryDatesIgnored: GanttProject derives a summary's dates and
// completion from its children, so a file that rewrote them says nothing.
func TestDiff_SummaryDatesIgnored(t *testing.T) {
	kA, kB := dfxKey(dfxA), dfxKey(dfxB)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 2),
		dfxTask(kB, kA, "Draft", dfxMon, 1),
	}, nil)
	// The current summary is closed and has children; the file's figure for both
	// is GanttProject's own arithmetic.
	cur.Tasks[0].HasChildren = true
	cur.Tasks[0].Complete = 100

	file := dfxPlan([]PlanTask{
		{Ref: kA, Name: "Design", Start: day(dfxDay(dfxWed)), Duration: 9, Complete: 40, HasChildren: true},
		dfxTask(kB, kA, "Draft", dfxTue, 1),
	}, nil)

	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "task:"+kB+":dates")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}

	// A summary's name is still its own, and a summary the file no longer
	// believes has children gets its dates back: the two checks that keep the
	// rule from being a blanket "skip every parent".
	file = dfxPlan([]PlanTask{
		{Ref: kA, Name: "Design v2", Start: day(dfxDay(dfxWed)), Duration: 9, Complete: 40, HasChildren: true},
		dfxTask(kB, kA, "Draft", dfxTue, 1),
	}, nil)
	renamed, _ := diffPlans(cur, file, nil)
	dfxWantKeys(t, renamed, "task:"+kA+":name", "task:"+kB+":dates")

	file = dfxPlan([]PlanTask{
		{Ref: kA, Name: "Design", Start: day(dfxDay(dfxWed)), Duration: 9, Complete: 40},
		dfxTask(kB, kA, "Draft", dfxTue, 1),
	}, nil)
	changes, _ = diffPlans(cur, file, nil)
	dfxWantKeys(t, changes,
		"task:"+kA+":dates",
		"task:"+kA+":closed",
		"task:"+kB+":dates",
	)
}

// TestDiff_SameNameIsCreate: only the Ref matches, never the name, so a
// copy-pasted row is a create and the original keeps its own name.
func TestDiff_SameNameIsCreate(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 3)}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 3),
		dfxNew("7", "", "Design", dfxMon, 3),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "new:7")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none: a name the file repeats is not a warning", warnings)
	}
	row := dfxRow(t, changes, "new:7")
	if row.Kind != "create" || row.Task != "Design" {
		t.Errorf("row = %+v, want a create named Design", row)
	}
	if got, want := dfxJSON(t, row.After), `{"name":"Design","parent":null,"start":"2026-03-02","end":"2026-03-04","planned_hours":0}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	if row.Wbs != "" {
		t.Errorf("wbs = %q, want none for a new task", row.Wbs)
	}
}

// TestDiff_ForeignIdsAreCreates: a file from another project is a wholesale
// import, and the project's own rows are offered for removal, unticked.
func TestDiff_ForeignIdsAreCreates(t *testing.T) {
	kA, kB, kG := dfxKey(dfxA), dfxKey(dfxB), dfxGateKey(dfxGate)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 3),
		dfxTask(kB, kA, "Draft", dfxMon, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, []PlanDep{{Pred: kB, Succ: kG}})

	file := dfxPlan([]PlanTask{
		dfxTask(dfxKey(dfxForeignA), "", "Design", dfxMon, 3),
		dfxTask(dfxKey(dfxForeignB), dfxKey(dfxForeignA), "Draft", dfxMon, 1),
		dfxMilestone(dfxGateKey(dfxForeignG), "Deliverable", dfxFri),
	}, nil)
	for i := range file.Tasks {
		file.Tasks[i].FileID = string(rune('1' + i))
	}

	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes,
		// Draft produced Deliverable; the foreign file names no such link, and
		// that removal is a row of its own, unticked like every other removal.
		"task:"+kB+":milestone_id",
		"task:"+kA+":delete",
		"task:"+kB+":delete",
		"milestone:"+dfxKey(dfxGate)+":delete",
		"new:1",
		"new:2",
		"new-milestone:3",
	)
	if got := dfxCount(changes, "create"); got != 2 {
		t.Errorf("%d create rows, want 2", got)
	}
	if got := dfxCount(changes, "milestone_create"); got != 1 {
		t.Errorf("%d milestone_create rows, want 1", got)
	}
	// One warning per file row: the ids name nothing in this project.
	for _, name := range []string{"Design", "Draft", "Deliverable"} {
		dfxWantWarning(t, warnings, "UNKNOWN_ID", name)
	}
	if len(warnings) != 3 {
		t.Errorf("%d warnings, want 3: %+v", len(warnings), warnings)
	}
	// The foreign file's rows are still a tree: Draft hangs under the Design the
	// file added, and needs that create.
	draft := dfxRow(t, changes, "new:2")
	if got, want := dfxJSON(t, draft.After), `{"name":"Draft","parent":"new:1","start":"2026-03-02","end":"2026-03-02","planned_hours":0}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	if got := draft.Requires; len(got) != 1 || got[0] != "new:1" {
		t.Errorf("requires = %v, want [new:1]", got)
	}
	// Nothing is ticked for removal, the deliverable the foreign file does not
	// name included: a file from another project touches nothing here.
	for _, key := range []string{
		"task:" + kA + ":delete", "task:" + kB + ":delete",
		"milestone:" + dfxKey(dfxGate) + ":delete", "task:" + kB + ":milestone_id",
	} {
		if row := dfxRow(t, changes, key); row.DefaultSelected {
			t.Errorf("row %s is ticked, want unticked", key)
		}
	}
	// A milestone the file added carries no parent and no hours.
	gate := dfxRow(t, changes, "new-milestone:3")
	if got, want := dfxJSON(t, gate.After), `{"name":"Deliverable","parent":null,"start":"2026-03-06","end":"2026-03-06","planned_hours":0}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
}

// TestDiff_InsertAtTopNoMoves: the move set is the siblings outside the longest
// run kept in order, so one new row near the top says nothing about the rows
// below it.
func TestDiff_InsertAtTopNoMoves(t *testing.T) {
	kA, kB, kC := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Ship", dfxWed, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxNew("9", "", "Kickoff", dfxMon, 1),
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Ship", dfxWed, 1),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "new:9")
	if got := dfxCount(changes, "move"); got != 0 {
		t.Errorf("%d move rows, want none: an insert is not a move of everything after it", got)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
}

// TestDiff_SwapTwoIsOneMove: of two siblings swapped, one is already where the
// file wants the other to go after it, so one row is enough.
func TestDiff_SwapTwoIsOneMove(t *testing.T) {
	kA, kB := dfxKey(dfxA), dfxKey(dfxB)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kA, "", "Design", dfxMon, 1),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	if len(changes) != 1 {
		t.Fatalf("rows = %s, want exactly one move", strings.Join(dfxKeys(changes), " "))
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	row := changes[0]
	if row.Kind != "move" || row.Field != "parent" {
		t.Errorf("row = %+v, want a move of parent", row)
	}
	wantKey := "task:" + kA + ":move"
	if row.Key != wantKey && row.Key != "task:"+kB+":move" {
		t.Errorf("key = %q, want the move of one of the two swapped tasks", row.Key)
	}
	// Whichever it is, it is placed where the file puts it: Design after Build,
	// or Build first with nothing before it.
	switch row.Key {
	case wantKey:
		if got, want := dfxJSON(t, row.After), `{"parent":null,"after":"`+kB+`"}`; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.Before), `{"parent":null,"after":null}`; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
	default:
		if got, want := dfxJSON(t, row.After), `{"parent":null,"after":null}`; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
	}
}

// TestDiff_LcsMovesAreMinimal: reversing three siblings keeps the longest run
// (one of them), so two rows, not three and not one.
func TestDiff_LcsMovesAreMinimal(t *testing.T) {
	kA, kB, kC := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Ship", dfxWed, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kC, "", "Ship", dfxWed, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kA, "", "Design", dfxMon, 1),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	if got := dfxCount(changes, "move"); got != 2 {
		t.Errorf("%d move rows in %s, want 2", got, strings.Join(dfxKeys(changes), " "))
	}
	if len(changes) != 2 || len(warnings) != 0 {
		t.Fatalf("rows = %s, warnings = %+v", strings.Join(dfxKeys(changes), " "), warnings)
	}
	// Each row says "under X, after Y" in the file's terms.
	for _, row := range changes {
		if row.Wbs == "" {
			t.Errorf("row %s has no wbs, want the current one", row.Key)
		}
		if !strings.HasPrefix(row.Key, "task:") || !strings.HasSuffix(row.Key, ":move") {
			t.Errorf("key = %q, want task:<uuid>:move", row.Key)
		}
	}
}

// TestDiff_MoveUnderANewParent: a parent change is always a move, and a move
// whose new parent or preceding sibling is new needs that create first.
func TestDiff_MoveUnderANewParent(t *testing.T) {
	kA, kB := dfxKey(dfxA), dfxKey(dfxB)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxNew("1", "", "Phase 1", dfxMon, 1),
		dfxNew("2", "new:1", "Phase 2", dfxMon, 1),
		dfxTask(kA, "new:1", "Design", dfxMon, 1),
		dfxTask(kB, "new:2", "Build", dfxTue, 1),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes,
		"new:1",
		"new:2",
		"task:"+kA+":move",
		"task:"+kB+":move",
	)
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	// Phase 2 hangs under the Phase 1 the file added.
	child := dfxRow(t, changes, "new:2")
	if got := child.Requires; len(got) != 1 || got[0] != "new:1" {
		t.Errorf("requires = %v, want [new:1]", got)
	}
	// Design moves under the new Phase 1, below the new Phase 2 that the file
	// lists before it: it needs both creates.
	design := dfxRow(t, changes, "task:"+kA+":move")
	if got, want := dfxJSON(t, design.After), `{"parent":"new:1","after":"new:2"}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, design.Before), `{"parent":null,"after":null}`; got != want {
		t.Errorf("before = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, design.Requires), `["new:1","new:2"]`; got != want {
		t.Errorf("requires = %s, want %s", got, want)
	}
	// Build moves under the new Phase 2, first under it: only that create.
	build := dfxRow(t, changes, "task:"+kB+":move")
	if got, want := dfxJSON(t, build.After), `{"parent":"new:2","after":null}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, build.Requires), `["new:2"]`; got != want {
		t.Errorf("requires = %s, want %s", got, want)
	}
}

// TestDiff_MoveAfterANewSibling: "after Y" may name a row the file added, which is
// why the row carries the create it depends on. The siblings the two orders agree
// on keep their place and say nothing.
func TestDiff_MoveAfterANewSibling(t *testing.T) {
	kA, kB, kC := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Review", dfxWed, 1),
	}, nil)
	// The file adds New below Design and moves Review above Build: the run it
	// keeps is Design then Build, so Review is the only row it has to state.
	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxNew("9", "", "New", dfxMon, 1),
		dfxTask(kC, "", "Review", dfxWed, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "new:9", "task:"+kC+":move")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	moved := dfxRow(t, changes, "task:"+kC+":move")
	if got, want := dfxJSON(t, moved.After), `{"parent":null,"after":"new:9"}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, moved.Before), `{"parent":null,"after":"`+kB+`"}`; got != want {
		t.Errorf("before = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, moved.Requires), `["new:9"]`; got != want {
		t.Errorf("requires = %s, want %s", got, want)
	}
}

// TestDiff_ParentDeleteRequiresChildren: deleting a summary while its children
// stay is not a whole decision, so the parent's row names the child removals it
// needs.
func TestDiff_ParentDeleteRequiresChildren(t *testing.T) {
	kA, kB, kC := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, kA, "Draft", dfxMon, 1),
		dfxTask(kC, kA, "Review", dfxTue, 1),
	}, nil)
	changes, warnings := diffPlans(cur, dfxPlan(nil, nil), nil)
	dfxWantKeys(t, changes,
		"task:"+kA+":delete",
		"task:"+kB+":delete",
		"task:"+kC+":delete",
	)
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	parent := dfxRow(t, changes, "task:"+kA+":delete")
	if got, want := parent.Requires, []string{"task:" + kB + ":delete", "task:" + kC + ":delete"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("requires = %v, want %v", got, want)
	}
	for _, key := range []string{"task:" + kB + ":delete", "task:" + kC + ":delete"} {
		if row := dfxRow(t, changes, key); len(row.Requires) != 0 {
			t.Errorf("row %s requires %v, want nothing", key, row.Requires)
		}
	}
	// The names come from EERP, since the file holds none of them.
	if parent.Task != "Design" {
		t.Errorf("task = %q, want Design", parent.Task)
	}
	if parent.Kind != "delete" {
		t.Errorf("kind = %q, want delete", parent.Kind)
	}
}

// TestDiff_DepKinds walks the four dependency cases the file can bring.
func TestDiff_DepKinds(t *testing.T) {
	kA, kB, kG := dfxKey(dfxA), dfxKey(dfxB), dfxGateKey(dfxGate)
	curTasks := []PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}

	t.Run("a type EERP has not is a warning", func(t *testing.T) {
		file := dfxPlan(curTasks, []PlanDep{{Pred: kA, Succ: kB, Type: DepSS}})
		changes, warnings := diffPlans(curTasksPlan(), file, nil)
		dfxWantNoRows(t, changes)
		dfxWantWarning(t, warnings, "DEP_TYPE", "Design")
		if len(warnings) != 1 {
			t.Errorf("%d warnings, want one: %+v", len(warnings), warnings)
		}
	})

	t.Run("a lag is dropped with a warning", func(t *testing.T) {
		file := dfxPlan(curTasks, []PlanDep{{Pred: kA, Succ: kB, Type: DepFS, Lag: 2}})
		changes, warnings := diffPlans(curTasksPlan(), file, nil)
		dfxWantKeys(t, changes, "dep:"+kA+":"+kB)
		dfxWantWarning(t, warnings, "DEP_LAG", "Design")
		row := dfxRow(t, changes, "dep:"+kA+":"+kB)
		if row.Kind != "dependency" {
			t.Errorf("kind = %q, want dependency", row.Kind)
		}
		if !row.DefaultSelected {
			t.Error("an added dependency is unticked, want ticked")
		}
		if got, want := dfxJSON(t, row.After), `{"pred":"`+kA+`","pred_name":"Design","succ":"`+kB+`","succ_name":"Build"}`; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
		if row.Before != nil {
			t.Errorf("before = %v, want null", row.Before)
		}
	})

	t.Run("a milestone predecessor is not a link EERP has", func(t *testing.T) {
		file := dfxPlan(curTasks, []PlanDep{{Pred: kG, Succ: kA}})
		changes, warnings := diffPlans(curTasksPlan(), file, nil)
		dfxWantNoRows(t, changes)
		dfxWantWarning(t, warnings, "DEP_FROM_MILESTONE", "Design")
		if len(warnings) != 1 {
			t.Errorf("%d warnings, want one: %+v", len(warnings), warnings)
		}
	})

	t.Run("a milestone successor sets the deliverable", func(t *testing.T) {
		file := dfxPlan(curTasks, []PlanDep{{Pred: kA, Succ: kG}})
		changes, warnings := diffPlans(curTasksPlan(), file, nil)
		dfxWantKeys(t, changes, "task:"+kA+":milestone_id")
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		row := dfxRow(t, changes, "task:"+kA+":milestone_id")
		if row.Kind != "update" || row.Field != "milestone_id" {
			t.Errorf("row = %+v, want an update of milestone_id", row)
		}
		if !row.DefaultSelected {
			t.Error("a deliverable the file adds is unticked, want ticked")
		}
		if got, want := dfxJSON(t, row.Before), "null"; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.After), `{"id":"`+kG+`","name":"Deliverable"}`; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
		if row.Task != "Design" {
			t.Errorf("task = %q, want Design", row.Task)
		}
	})

	t.Run("only finish to start is compared at all", func(t *testing.T) {
		// A current plan holding something the loader can never produce is
		// ignored rather than reported as a removal.
		cur := dfxPlan(curTasks, []PlanDep{{Pred: kA, Succ: kB, Type: DepFF}})
		file := dfxPlan(curTasks, nil)
		dfxWantNoChange(t, cur, file, nil)
	})
}

// curTasksPlan is the current side of TestDiff_DepKinds: the same three rows
// with no dependencies.
func curTasksPlan() Plan {
	return dfxPlan([]PlanTask{
		dfxKeyed(dfxA, "", "Design", dfxMon, 1),
		dfxKeyed(dfxB, "", "Build", dfxTue, 1),
		dfxMilestoneKeyed(dfxGate, "Deliverable", dfxFri),
	}, nil)
}

func dfxKeyed(id uuid.UUID, parent, name, start string, dur int) PlanTask {
	return dfxTask(dfxKey(id), parent, name, start, dur)
}

func dfxMilestoneKeyed(id uuid.UUID, name, start string) PlanTask {
	return dfxMilestone(dfxGateKey(id), name, start)
}

// TestDiff_MultiMilestoneFirstWins: a task produces one deliverable, so the
// first milestone successor is used and the rest are reported.
func TestDiff_MultiMilestoneFirstWins(t *testing.T) {
	kA, kG, kG2 := dfxKey(dfxA), dfxGateKey(dfxGate), dfxGateKey(dfxGate2)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
		dfxMilestone(kG2, "Second", dfxFri),
	}, nil)
	file := dfxPlan(cur.Tasks, []PlanDep{{Pred: kA, Succ: kG}, {Pred: kA, Succ: kG2}})
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "task:"+kA+":milestone_id")
	row := dfxRow(t, changes, "task:"+kA+":milestone_id")
	if got, want := dfxJSON(t, row.After), `{"id":"`+kG+`","name":"Deliverable"}`; got != want {
		t.Errorf("after = %s, want the first milestone %s", got, want)
	}
	dfxWantWarning(t, warnings, "MULTI_MILESTONE", "Design")
	if len(warnings) != 1 {
		t.Errorf("%d warnings, want one: %+v", len(warnings), warnings)
	}
}

// TestDiff_MilestoneLinkOfNewTaskGoesInCreate: a row the file added has no
// task to update, so its deliverable rides inside its create.
func TestDiff_MilestoneLinkOfNewTaskGoesInCreate(t *testing.T) {
	kG := dfxGateKey(dfxGate)
	cur := dfxPlan([]PlanTask{dfxMilestone(kG, "Deliverable", dfxFri)}, nil)
	file := dfxPlan([]PlanTask{
		dfxNew("4", "", "Draft", dfxMon, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, []PlanDep{{Pred: "new:4", Succ: kG}})
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "new:4")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	row := dfxRow(t, changes, "new:4")
	if got, want := dfxJSON(t, row.After), `{"name":"Draft","parent":null,"start":"2026-03-02","end":"2026-03-02","planned_hours":0,"milestone_id":{"id":"`+kG+`","name":"Deliverable"}}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
}

// TestDiff_NewMilestoneLinkRequiresItsCreate: a deliverable the file invented has
// to exist before an existing task can point at it, so the update names the create
// it waits for. One milestone successor is not a conflict, so nothing is warned.
func TestDiff_NewMilestoneLinkRequiresItsCreate(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxNewMilestone("9", "Ship", dfxFri),
	}, []PlanDep{{Pred: kA, Succ: "new-milestone:9"}})
	changes, warnings := diffPlans(cur, file, nil)
	// The update reads under the task it is about, the create where the file
	// placed the milestone; Requires is what apply has to honour.
	dfxWantKeys(t, changes, "task:"+kA+":milestone_id", "new-milestone:9")
	dfxWantNoWarning(t, warnings, "MULTI_MILESTONE")
	if len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none", warnings)
	}

	create := dfxRow(t, changes, "new-milestone:9")
	if create.Kind != "milestone_create" {
		t.Errorf("kind = %q, want milestone_create", create.Kind)
	}
	if !create.DefaultSelected {
		t.Error("a create should arrive ticked")
	}
	if create.Wbs != "" {
		t.Errorf("wbs = %q, want none for a row EERP does not hold", create.Wbs)
	}

	link := dfxRow(t, changes, "task:"+kA+":milestone_id")
	if !link.DefaultSelected {
		t.Error("giving a task its deliverable destroys nothing and should arrive ticked")
	}
	if got, want := dfxJSON(t, link.After), `{"id":"new-milestone:9","name":"Ship"}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, link.Before), "null"; got != want {
		t.Errorf("before = %s, want null", got)
	}
	if got, want := dfxJSON(t, link.Requires), `["new-milestone:9"]`; got != want {
		t.Errorf("requires = %s, want %s", got, want)
	}
}

// TestDiff_RemovalsUnticked: nothing that destroys data arrives pre-selected,
// and everything else does.
func TestDiff_RemovalsUnticked(t *testing.T) {
	kA, kB, kG := dfxKey(dfxA), dfxKey(dfxB), dfxGateKey(dfxGate)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, []PlanDep{{Pred: kA, Succ: kB}, {Pred: kA, Succ: kG}},
		PlanAssign{Task: kB, Email: "ann@x.com", Name: "Ann"})

	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design v2", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxNew("9", "", "Ship", dfxWed, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, nil)
	changes, warnings := diffPlans(cur, file, dfxUsers())
	if len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none", warnings)
	}
	dfxWantKeys(t, changes,
		"task:"+kA+":name",
		"task:"+kA+":milestone_id",
		"dep:"+kA+":"+kB+":delete",
		"assign:"+kB+":ann@x.com:delete",
		"new:9",
	)
	unticked := map[string]bool{
		"task:" + kA + ":milestone_id":       true,
		"dep:" + kA + ":" + kB + ":delete":   true,
		"assign:" + kB + ":ann@x.com:delete": true,
	}
	for _, row := range changes {
		want := !unticked[row.Key]
		if strings.HasSuffix(row.Kind, "_delete") && !unticked[row.Key] {
			t.Errorf("row %s of kind %s is a removal but is not in the unticked set", row.Key, row.Kind)
		}
		if row.DefaultSelected != want {
			t.Errorf("row %s (kind %s) ticked = %v, want %v", row.Key, row.Kind, row.DefaultSelected, want)
		}
	}
	// The cleared deliverable reads "Deliverable: M to nothing", unticked.
	cleared := dfxRow(t, changes, "task:"+kA+":milestone_id")
	if got, want := dfxJSON(t, cleared.Before), `{"id":"`+kG+`","name":"Deliverable"}`; got != want {
		t.Errorf("before = %s, want %s", got, want)
	}
	if got, want := dfxJSON(t, cleared.After), "null"; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	// The removed dependency and assignment name both ends, for the label.
	dep := dfxRow(t, changes, "dep:"+kA+":"+kB+":delete")
	if got, want := dfxJSON(t, dep.Before), `{"pred":"`+kA+`","pred_name":"Design","succ":"`+kB+`","succ_name":"Build"}`; got != want {
		t.Errorf("before = %s, want %s", got, want)
	}
	assign := dfxRow(t, changes, "assign:"+kB+":ann@x.com:delete")
	if got, want := dfxJSON(t, assign.Before), `{"task":"`+kB+`","email":"ann@x.com","name":"Ann"}`; got != want {
		t.Errorf("before = %s, want %s", got, want)
	}
	if assign.Task != "Build" {
		t.Errorf("task = %q, want Build", assign.Task)
	}
}

// TestDiff_RequiresNewEnds: a dependency or an assignment on a row the file
// added cannot be applied before that row exists.
func TestDiff_RequiresNewEnds(t *testing.T) {
	kA, kB := dfxKey(dfxA), dfxKey(dfxB)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxNew("7", "", "Ship", dfxWed, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
	}, []PlanDep{
		{Pred: "new:7", Succ: kB},
		{Pred: kA, Succ: "new:7"},
	}, PlanAssign{Task: "new:7", Email: "ann@x.com", Name: "Ann"})
	changes, warnings := diffPlans(cur, file, dfxUsers())
	// A dependency is grouped under its predecessor, the way the file draws it.
	dfxWantKeys(t, changes,
		"dep:"+kA+":new:7",
		"new:7",
		"dep:new:7:"+kB,
		"assign:new:7:ann@x.com",
	)
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	for _, tc := range []struct {
		key  string
		want []string
	}{
		{"dep:new:7:" + kB, []string{"new:7"}},
		{"dep:" + kA + ":new:7", []string{"new:7"}},
		{"assign:new:7:ann@x.com", []string{"new:7"}},
	} {
		row := dfxRow(t, changes, tc.key)
		if len(row.Requires) != 1 || row.Requires[0] != tc.want[0] {
			t.Errorf("row %s requires %v, want %v", tc.key, row.Requires, tc.want)
		}
	}
	// The create itself needs nothing.
	if got := dfxRow(t, changes, "new:7").Requires; len(got) != 0 {
		t.Errorf("create requires %v, want nothing", got)
	}
}

// TestDiff_UnknownEmail: a person EERP has no staff account for cannot be
// assigned, and the manager is told who.
func TestDiff_UnknownEmail(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil,
		PlanAssign{Task: kA, Email: "Ghost@X.com", Name: "Ghost"},
		PlanAssign{Task: kA, Email: "ann@x.com", Name: "Ann"},
	)
	changes, warnings := diffPlans(cur, file, dfxUsers())
	dfxWantKeys(t, changes, "assign:"+kA+":ann@x.com")
	dfxWantWarning(t, warnings, "UNKNOWN_EMAIL", "Design")
	if len(warnings) != 1 {
		t.Fatalf("%d warnings, want one: %+v", len(warnings), warnings)
	}
	if !strings.Contains(warnings[0].Message, "Ghost@X.com") {
		t.Errorf("message %q does not name the address the file carried", warnings[0].Message)
	}
	row := dfxRow(t, changes, "assign:"+kA+":ann@x.com")
	if row.Kind != "assign" {
		t.Errorf("kind = %q, want assign", row.Kind)
	}
	// The email is lowercased the way the staff map is keyed, so the same person
	// written two ways in one file is one row.
	if got, want := dfxJSON(t, row.After), `{"task":"`+kA+`","email":"ann@x.com","name":"Ann"}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
}

// TestDiff_AssigneeCaseIsNotAPerson: the same account written twice, in two
// cases, is one assignment.
func TestDiff_AssigneeCaseIsNotAPerson(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil,
		PlanAssign{Task: kA, Email: "ANN@x.com", Name: "Ann"})
	file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil,
		PlanAssign{Task: kA, Email: "ann@X.com", Name: "Ann"})
	dfxWantNoChange(t, cur, file, dfxUsers())
}

// TestDiff_DuplicateRefConsumeAndMark: the first file row carrying an identity
// matches, the copy-paste after it is a new task. The current row is neither
// deleted nor written twice.
func TestDiff_DuplicateRefConsumeAndMark(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	first := dfxTask(kA, "", "Design", dfxMon, 1)
	first.FileID = "1"
	second := dfxTask(kA, "", "Design", dfxTue, 2)
	second.FileID = "2"
	changes, warnings := diffPlans(cur, dfxPlan([]PlanTask{first, second}, nil), nil)
	dfxWantKeys(t, changes, "new:2")
	dfxWantWarning(t, warnings, "DUPLICATE_ID", "Design")
	row := dfxRow(t, changes, "new:2")
	if row.Kind != "create" {
		t.Errorf("kind = %q, want create", row.Kind)
	}
	if got, want := dfxJSON(t, row.After), `{"name":"Design","parent":null,"start":"2026-03-03","end":"2026-03-04","planned_hours":0}`; got != want {
		t.Errorf("after = %s, want %s", got, want)
	}
	// The second row's key is its own, never the identity it copied.
	if row.Key == kA || row.Key == "task:"+kA+":create" {
		t.Errorf("key = %q, want the new row's own key", row.Key)
	}
}

// TestDiff_DuplicateCurrentRowStillRemoves: a plan holding two rows under one
// identity (only a hand-built plan can; the database cannot) matches the first and
// still shows the second as a removal. A map keyed on identity would silently drop
// it, and the project would keep a task nobody was asked about.
func TestDiff_DuplicateCurrentRowStillRemoves(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kA, "", "Design", dfxTue, 1),
	}, nil)
	file := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "task:"+kA+":delete")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	if got := dfxCount(changes, "delete"); got != 1 {
		t.Errorf("%d delete rows, want exactly one: the row that matched is not a removal", got)
	}
}

// TestDiff_DuplicateFileIdKeepsBothRows: Key() builds a new row's key from the
// file id, so two rows calling themselves the same (which only a hand-written .gan
// can do: a decoded one numbers its rows and refuses an absent id) would share a
// key, and one of them would never be created.
func TestDiff_DuplicateFileIdKeepsBothRows(t *testing.T) {
	one := dfxNew("3", "", "One", dfxMon, 1)
	two := dfxNew("3", "", "Two", dfxTue, 1)
	changes, warnings := diffPlans(Plan{Weekend: DefaultWeekend}, dfxPlan([]PlanTask{one, two}, nil), nil)
	if len(changes) != 2 {
		t.Fatalf("rows = %s, want two creates", strings.Join(dfxKeys(changes), " "))
	}
	if len(warnings) != 1 || warnings[0].Code != "DUPLICATE_ID" || warnings[0].Task != "Two" {
		t.Errorf("warnings = %+v, want one DUPLICATE_ID about Two", warnings)
	}
	if changes[0].Key == changes[1].Key {
		t.Errorf("both rows share the key %q", changes[0].Key)
	}
	if changes[0].Key != "new:3" {
		t.Errorf("first key = %q, want new:3", changes[0].Key)
	}
	if !strings.HasPrefix(changes[1].Key, "new:3") || changes[1].Key == "new:3" {
		t.Errorf("second key = %q, want a key of its own beside new:3", changes[1].Key)
	}
	if changes[1].Task != "Two" {
		t.Errorf("task = %q, want Two", changes[1].Task)
	}
}

// TestDiff_KindMismatchIsCreate: an eerp_id whose milestone-ness contradicts the
// row carrying it names nothing EERP can match it to, so it is a create and the
// row it contradicts is offered for removal.
func TestDiff_KindMismatchIsCreate(t *testing.T) {
	kA := dfxKey(dfxA)
	kG := dfxGateKey(dfxGate)

	t.Run("a task wearing a milestone id", func(t *testing.T) {
		cur := dfxPlan([]PlanTask{dfxMilestone(kG, "Deliverable", dfxFri)}, nil)
		rogue := dfxTask(kG, "", "Deliverable", dfxFri, 0)
		rogue.FileID = "1"
		changes, warnings := diffPlans(cur, dfxPlan([]PlanTask{rogue}, nil), nil)
		dfxWantKeys(t, changes, "milestone:"+dfxKey(dfxGate)+":delete", "new:1")
		dfxWantWarning(t, warnings, "UNKNOWN_ID", "Deliverable")
		// The row says it is a task, so it becomes one: the milestone it
		// contradicted is only offered for removal, never silently rewritten.
		if got := dfxCount(changes, "create"); got != 1 {
			t.Errorf("%d create rows, want 1", got)
		}
		if got := dfxCount(changes, "milestone_create"); got != 0 {
			t.Errorf("%d milestone_create rows, want none", got)
		}
	})

	t.Run("a milestone wearing a task id", func(t *testing.T) {
		cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 3)}, nil)
		rogue := dfxMilestone(kA, "Design", dfxMon)
		rogue.FileID = "1"
		changes, warnings := diffPlans(cur, dfxPlan([]PlanTask{rogue}, nil), nil)
		dfxWantKeys(t, changes, "task:"+kA+":delete", "new-milestone:1")
		dfxWantWarning(t, warnings, "UNKNOWN_ID", "Design")
	})
}

// TestDiff_HostileRefCannotStealAKey: Key() builds a new row's key from its file
// id, so a file allowed to put new:7 in eerp_id would be handed another row's
// key and that row would vanish. The decoder refuses such an id; the diff does
// not trust it either.
func TestDiff_HostileRefCannotStealAKey(t *testing.T) {
	kA := dfxKey(dfxA)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	// A row claiming the new: namespace, and the ordinary new row whose key that
	// claim would have stolen.
	stealer := dfxTask("new:7", "", "Stealer", dfxMon, 1)
	stealer.FileID = "9"
	victim := dfxNew("7", "", "Victim", dfxMon, 1)
	changes, warnings := diffPlans(cur, dfxPlan([]PlanTask{stealer, victim}, nil), nil)
	dfxWantKeys(t, changes, "task:"+kA+":delete", "new:9", "new:7")
	dfxWantWarning(t, warnings, "UNKNOWN_ID", "Stealer")
	// One row, one complaint: the id is refused once, not once for being malformed
	// and again for naming nothing.
	if len(warnings) != 1 {
		t.Errorf("%d warnings, want one: %+v", len(warnings), warnings)
	}
	if dfxCount(changes, "create") != 2 {
		t.Errorf("rows = %s, want two creates: neither may be swallowed by the other", strings.Join(dfxKeys(changes), " "))
	}
}

// TestDiff_DepsAreASet: Plan.Deps order means nothing, so two plans holding the
// same dependencies in another order are the same plan.
func TestDiff_DepsAreASet(t *testing.T) {
	kA, kB, kC, kD := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC), dfxKey(dfxDrop)
	tasks := []PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Test", dfxWed, 1),
		dfxTask(kD, "", "Ship", dfxThu, 1),
	}
	cur := dfxPlan(tasks, []PlanDep{
		{Pred: kA, Succ: kB},
		{Pred: kC, Succ: kD},
		{Pred: kB, Succ: kC},
	})
	file := dfxPlan(tasks, []PlanDep{
		{Pred: kB, Succ: kC},
		{Pred: kC, Succ: kD},
		{Pred: kA, Succ: kB},
	})
	dfxWantNoChange(t, cur, file, nil)

	// The same dependency written twice is still one, and not a change.
	file.Deps = append(file.Deps, PlanDep{Pred: kA, Succ: kB})
	dfxWantNoChange(t, cur, file, nil)

	// And twice is still one row when EERP does not have it: a key the wizard
	// would show twice is a key it cannot tick once.
	fileWithNew := dfxPlan(tasks, []PlanDep{
		{Pred: kA, Succ: kB},
		{Pred: kC, Succ: kD},
		{Pred: kB, Succ: kC},
	})
	fileWithNew.Deps = append(fileWithNew.Deps,
		PlanDep{Pred: kB, Succ: kA}, PlanDep{Pred: kB, Succ: kA})
	// EERP holds everything the file has except the link from Build to Design.
	empty := dfxPlan(tasks, []PlanDep{
		{Pred: kA, Succ: kB},
		{Pred: kC, Succ: kD},
		{Pred: kB, Succ: kC},
	})
	changes, warnings := diffPlans(empty, fileWithNew, nil)
	dfxWantKeys(t, changes, "dep:"+kB+":"+kA)
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
}

// TestDiff_MilestoneRowsAreNameAndDeadline: EERP holds neither hours nor a
// completion for a milestone, so a file inventing them says nothing.
func TestDiff_MilestoneRowsAreNameAndDeadline(t *testing.T) {
	kA, kG := dfxKey(dfxA), dfxGateKey(dfxGate)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, nil)

	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		{Ref: kG, Name: "Deliverable", Start: day(dfxDay(dfxFri)), Milestone: true, Complete: 100, PlannedHours: 8, HasChildren: true},
	}, nil)
	dfxWantNoChange(t, cur, file, nil)

	file.Tasks[1].Name = "Ship gate"
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "milestone:"+dfxKey(dfxGate)+":name")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
	row := dfxRow(t, changes, "milestone:"+dfxKey(dfxGate)+":name")
	if row.Kind != "milestone_update" {
		t.Errorf("kind = %q, want milestone_update", row.Kind)
	}
	if row.Wbs != "" {
		t.Errorf("wbs = %q, want none: a milestone has no WBS position", row.Wbs)
	}

	file.Tasks[1].Start = day(dfxDay(dfxMon2))
	changes, _ = diffPlans(cur, file, nil)
	dfxWantKeys(t, changes,
		"milestone:"+dfxKey(dfxGate)+":name",
		"milestone:"+dfxKey(dfxGate)+":dates",
	)
}

// TestDiff_ClosedOnlyCrossesAtHundred: completion means closed and nothing else.
func TestDiff_ClosedOnlyCrossesAtHundred(t *testing.T) {
	kA := dfxKey(dfxA)
	open := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	closed := dfxPlan([]PlanTask{func() PlanTask {
		task := dfxTask(kA, "", "Design", dfxMon, 1)
		task.Complete = 100
		return task
	}()}, nil)

	t.Run("below a hundred is not a closing", func(t *testing.T) {
		file := dfxPlan([]PlanTask{func() PlanTask {
			task := dfxTask(kA, "", "Design", dfxMon, 1)
			task.Complete = 99
			return task
		}()}, nil)
		dfxWantNoChange(t, open, file, nil)
	})

	t.Run("closing", func(t *testing.T) {
		changes, _ := diffPlans(open, closed, nil)
		dfxWantKeys(t, changes, "task:"+kA+":closed")
		row := dfxRow(t, changes, "task:"+kA+":closed")
		if got, want := dfxJSON(t, row.Before), "false"; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.After), "true"; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
	})

	t.Run("reopening", func(t *testing.T) {
		changes, _ := diffPlans(closed, open, nil)
		row := dfxRow(t, changes, "task:"+kA+":closed")
		if got, want := dfxJSON(t, row.Before), "true"; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.After), "false"; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
	})

	// Hours compare at a cent, so a planner's rounding is not a change.
	t.Run("hours compare at a cent", func(t *testing.T) {
		withHours := func(h float64) Plan {
			p := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
			p.Tasks[0].PlannedHours = h
			return p
		}
		dfxWantNoChange(t, withHours(8), withHours(8.001), nil)
		changes, _ := diffPlans(withHours(8), withHours(8.5), nil)
		dfxWantKeys(t, changes, "task:"+kA+":planned_hours")
		row := dfxRow(t, changes, "task:"+kA+":planned_hours")
		if got, want := dfxJSON(t, row.Before), "8"; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.After), "8.5"; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
	})
}

// TestDiff_NameTruncated: the column holds 200 characters, and a partner's file
// may hold more.
func TestDiff_NameTruncated(t *testing.T) {
	kA := dfxKey(dfxA)
	long := strings.Repeat("é", 201)
	cur := dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil)
	file := dfxPlan([]PlanTask{dfxTask(kA, "", long, dfxMon, 1)}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "task:"+kA+":name")
	dfxWantWarning(t, warnings, "NAME_TRUNCATED", long)
	row := dfxRow(t, changes, "task:"+kA+":name")
	if got, want := row.After.(string), strings.Repeat("é", 200); got != want {
		t.Errorf("after = %d runes, want the first 200 of the file's name", len([]rune(got)))
	}
	// The row names the task as EERP knows it; the warning quotes what the file
	// called it, which is the string that does not fit.
	if row.Task != "Design" {
		t.Errorf("task = %q, want the current name", row.Task)
	}
	// A name already short enough is not truncated, and 200 runes fit.
	file.Tasks[0].Name = strings.Repeat("é", 200)
	dfxWantNoChange(t, dfxPlan([]PlanTask{dfxTask(kA, "", strings.Repeat("é", 200), dfxMon, 1)}, nil), file, nil)
}

// TestDiff_DeleteRowsFollowFormerNeighbours: a removal is shown where the task
// used to sit, so the list still reads like the project.
//
// The neighbour is found in the project's order and written as a *file* position.
// The two orders only agree while the file keeps the project's order above the lost
// row, so the cases that matter are the ones where it does not: a create or a move
// inserted above the lost row shifts the file's indices and not the project's.
func TestDiff_DeleteRowsFollowFormerNeighbours(t *testing.T) {
	kA, kB, kDrop := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxDrop)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kDrop, "", "Scratch", dfxTue, 1),
		dfxTask(kB, "", "Build", dfxWed, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design v2", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxWed, 1),
	}, nil)
	changes, _ := diffPlans(cur, file, nil)
	dfxWantKeys(t, changes,
		"task:"+kA+":name",
		"task:"+kDrop+":delete",
	)

	// A first row the file dropped comes before everything.
	cur = dfxPlan([]PlanTask{
		dfxTask(kDrop, "", "Scratch", dfxMon, 1),
		dfxTask(kA, "", "Design", dfxMon, 1),
	}, nil)
	file = dfxPlan([]PlanTask{dfxTask(kA, "", "Design v2", dfxMon, 1)}, nil)
	changes, _ = diffPlans(cur, file, nil)
	dfxWantKeys(t, changes, "task:"+kDrop+":delete", "task:"+kA+":name")

	// A create inserted above the lost row. Scratch used to sit right after Build,
	// so its removal reads after Build's group; reading the neighbour's current
	// index instead of its file position would drop it inside Design's group, above
	// the neighbour it follows.
	cur = dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kDrop, "", "Scratch", dfxWed, 1),
	}, nil)
	t.Run("a create inserted above a lost row", func(t *testing.T) {
		file := dfxPlan([]PlanTask{
			dfxNew("9", "", "Kickoff", dfxMon, 1),
			dfxTask(kA, "", "Design v2", dfxMon, 1),
			dfxTask(kB, "", "Build v2", dfxTue, 1),
		}, nil)
		changes, warnings := diffPlans(cur, file, nil)
		if len(warnings) != 0 {
			t.Fatalf("warnings = %+v, want none", warnings)
		}
		if got := dfxCount(changes, "move"); got != 0 {
			t.Errorf("%d move rows, want none: an insert above is not a move of what is below it", got)
		}
		dfxWantKeys(t, changes,
			"new:9",
			"task:"+kA+":name",
			"task:"+kB+":name",
			"task:"+kDrop+":delete",
		)
	})

	// The same with a move above it rather than a create. The file puts Build before
	// Design, which moves Build (Design is the sibling the longest run keeps), and
	// Build is also Scratch's former neighbour: the removal follows the neighbour's
	// group where the file now puts it, the first one, not the group the project
	// numbered above it.
	t.Run("a move above a lost row", func(t *testing.T) {
		file := dfxPlan([]PlanTask{
			dfxTask(kB, "", "Build", dfxTue, 1),
			dfxTask(kA, "", "Design v2", dfxMon, 1),
		}, nil)
		changes, warnings := diffPlans(cur, file, nil)
		if len(warnings) != 0 {
			t.Fatalf("warnings = %+v, want none", warnings)
		}
		if got := dfxCount(changes, "move"); got != 1 {
			t.Errorf("%d move rows, want the one swap to cost one", got)
		}
		dfxWantKeys(t, changes,
			"task:"+kB+":move",
			"task:"+kDrop+":delete",
			"task:"+kA+":name",
		)
	})
}

// TestDiff_RowOrder is the wizard's reading order: the file's task order, and
// inside a task creates, moves, updates, dependencies, assignees, removals.
func TestDiff_RowOrder(t *testing.T) {
	kA, kB, kC, kG := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC), dfxGateKey(dfxGate)
	cur := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Test", dfxWed, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, []PlanDep{{Pred: kA, Succ: kB}, {Pred: kA, Succ: kG}},
		PlanAssign{Task: kB, Email: "ann@x.com", Name: "Ann"})
	file := dfxPlan([]PlanTask{
		{Ref: kA, Name: "Design v2", Start: day(dfxDay(dfxTue)), Duration: 1},
		dfxNew("9", "", "Draft", dfxMon, 1),
		dfxTask(kB, "", "Build", dfxTue, 1),
		dfxTask(kC, "", "Test", dfxWed, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, nil, PlanAssign{Task: "new:9", Email: "ann@x.com", Name: "Ann"})

	changes, warnings := diffPlans(cur, file, dfxUsers())
	if len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none", warnings)
	}
	dfxWantKeys(t, changes,
		// Design: renamed, then its dates, then what it used to be linked to.
		"task:"+kA+":name",
		"task:"+kA+":dates",
		"task:"+kA+":milestone_id",
		"dep:"+kA+":"+kB+":delete",
		// Draft: created and assigned.
		"new:9",
		"assign:new:9:ann@x.com",
		// Build: unlinked from Design, then stripped of its assignee.
		"assign:"+kB+":ann@x.com:delete",
	)
}

// TestDiff_WbsFromTheCurrentTree: the wizard groups rows by WBS number, so every
// row about a task EERP holds carries it, and a new row carries none.
func TestDiff_WbsFromTheCurrentTree(t *testing.T) {
	kP := dfxKey(dfxA)
	kC1 := dfxKey(dfxB)
	kC2 := dfxKey(dfxC)
	kQ := dfxKey(dfxDrop)
	cur := dfxPlan([]PlanTask{
		dfxTask(kP, "", "Phase 1", dfxMon, 1),
		dfxTask(kC1, kP, "Design", dfxMon, 1),
		dfxTask(kC2, kP, "Build", dfxTue, 1),
		dfxTask(kQ, "", "Phase 2", dfxWed, 1),
	}, nil)
	file := dfxPlan([]PlanTask{
		dfxTask(kP, "", "Phase 1", dfxMon, 1),
		dfxTask(kC1, kP, "Design", dfxMon, 1),
		dfxTask(kC2, kP, "Build v2", dfxTue, 1),
		dfxTask(kQ, "", "Phase 2 v2", dfxWed, 1),
		dfxNew("9", "", "Extra", dfxThu, 1),
	}, nil)
	changes, warnings := diffPlans(cur, file, nil)
	if len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none", warnings)
	}
	for key, want := range map[string]string{
		"task:" + kC2 + ":name": "1.2",
		"task:" + kQ + ":name":  "2",
	} {
		if got := dfxRow(t, changes, key).Wbs; got != want {
			t.Errorf("row %s wbs = %q, want %q", key, got, want)
		}
	}
	if got := dfxRow(t, changes, "new:9").Wbs; got != "" {
		t.Errorf("new row wbs = %q, want none", got)
	}
}

// TestDiff_DeletionOfATaskNeverSubsumesItsRows: a removal is never shown twice, but
// it is never made unsayable either. The loss of a task is one decision; the loss of
// one of its dependencies, of a person on it, or of its deliverable is another.
//
// The case the rows exist for: the file drops both task X and the link A to X, and
// the manager unticks X's removal to keep X. Without a row of its own for the link,
// the file's divergence from the project has nothing to tick, and the manager cannot
// import what they meant. Every such row arrives unticked, so the cost of always
// writing one is a row nobody selected. The brief asks for each of them
// unconditionally ("removed -> dependency_delete (unticked)", "Removed ->
// assign_delete (unticked)", "A removed milestone link -> a milestone_id update to
// null (unticked)"); the spec's "Selection consistency" section binds only a row on
// a new task needing its create and a summary not deleted while its subtasks stay.
func TestDiff_DeletionOfATaskNeverSubsumesItsRows(t *testing.T) {
	kA, kB, kG := dfxKey(dfxA), dfxKey(dfxB), dfxGateKey(dfxGate)

	t.Run("the dependency and the assignee of a task the file dropped", func(t *testing.T) {
		cur := dfxPlan([]PlanTask{
			dfxTask(kA, "", "Design", dfxMon, 1),
			dfxTask(kB, "", "Build", dfxTue, 1),
		}, []PlanDep{{Pred: kA, Succ: kB}},
			PlanAssign{Task: kA, Email: "ann@x.com", Name: "Ann"})
		file := dfxPlan([]PlanTask{dfxTask(kB, "", "Build", dfxTue, 1)}, nil)
		changes, warnings := diffPlans(cur, file, dfxUsers())
		// The task's own removal first: nothing is ticked, so the default still
		// keeps the task, its link and its person, and each loss is ticked on its own.
		dfxWantKeys(t, changes,
			"task:"+kA+":delete",
			"dep:"+kA+":"+kB+":delete",
			"assign:"+kA+":ann@x.com:delete",
		)
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		for _, key := range dfxKeys(changes) {
			if row := dfxRow(t, changes, key); row.DefaultSelected {
				t.Errorf("row %s is ticked, want unticked: every one of these destroys data", key)
			}
		}
		// The rows still name both ends, so the wizard can label them without the
		// task they belong to being there to look up.
		if got, want := dfxJSON(t, dfxRow(t, changes, "dep:"+kA+":"+kB+":delete").Before),
			`{"pred":"`+kA+`","pred_name":"Design","succ":"`+kB+`","succ_name":"Build"}`; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, dfxRow(t, changes, "assign:"+kA+":ann@x.com:delete").Before),
			`{"task":"`+kA+`","email":"ann@x.com","name":"Ann"}`; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
	})

	t.Run("the deliverable of a task the file dropped", func(t *testing.T) {
		cur := dfxPlan([]PlanTask{
			dfxTask(kA, "", "Design", dfxMon, 1),
			dfxMilestone(kG, "Deliverable", dfxFri),
		}, []PlanDep{{Pred: kA, Succ: kG}})
		file := dfxPlan([]PlanTask{dfxMilestone(kG, "Deliverable", dfxFri)}, nil)
		changes, warnings := diffPlans(cur, file, nil)
		dfxWantKeys(t, changes,
			"task:"+kA+":milestone_id",
			"task:"+kA+":delete",
		)
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		row := dfxRow(t, changes, "task:"+kA+":milestone_id")
		if row.DefaultSelected {
			t.Error("a cleared deliverable is ticked, want unticked like any other removal")
		}
		if got, want := dfxJSON(t, row.Before), `{"id":"`+kG+`","name":"Deliverable"}`; got != want {
			t.Errorf("before = %s, want %s", got, want)
		}
		if got, want := dfxJSON(t, row.After), "null"; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
	})

	// A deliverable the file *added* on a row the file also added still rides inside
	// that row's create rather than becoming a second row (TestDiff_MilestoneLinkOf
	// NewTaskGoesInCreate), and a row the file holds keeps its own clearing row
	// (TestDiff_RemovalsUnticked): the two cases the guard in linkRow separates.
	t.Run("a task the file dropped is not offered a milestone update it cannot hold", func(t *testing.T) {
		cur := dfxPlan([]PlanTask{
			dfxTask(kA, "", "Design", dfxMon, 1),
			dfxMilestone(kG, "Deliverable", dfxFri),
		}, []PlanDep{{Pred: kA, Succ: kG}})
		file := dfxPlan([]PlanTask{
			dfxNew("9", "", "Design", dfxMon, 1),
			dfxMilestone(kG, "Deliverable", dfxFri),
		}, []PlanDep{{Pred: "new:9", Succ: kG}})
		changes, warnings := diffPlans(cur, file, nil)
		// The file's Design is a new row (its eerp_id is absent, so it never matched),
		// EERP's Design is offered for removal with its deliverable, and the new row
		// carries its own deliverable inside its create.
		dfxWantKeys(t, changes,
			"task:"+kA+":milestone_id",
			"task:"+kA+":delete",
			"new:9",
		)
		if len(warnings) != 0 {
			t.Errorf("warnings = %+v, want none", warnings)
		}
		if got, want := dfxJSON(t, dfxRow(t, changes, "new:9").After),
			`{"name":"Design","parent":null,"start":"2026-03-02","end":"2026-03-02","planned_hours":0,"milestone_id":{"id":"`+kG+`","name":"Deliverable"}}`; got != want {
			t.Errorf("after = %s, want %s", got, want)
		}
	})
}

// TestDiff_AssignmentsOfUnknownRowsAreIgnored: an assignment hangs on a task EERP
// holds. One pointing at a row the file does not have, or at a milestone, is
// nothing to do: EERP assigns people to tasks.
func TestDiff_AssignmentsOfUnknownRowsAreIgnored(t *testing.T) {
	kA, kG := dfxKey(dfxA), dfxGateKey(dfxGate)
	both := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}, nil,
		PlanAssign{Task: kG, Email: "ann@x.com", Name: "Ann"},
		PlanAssign{Task: "gone", Email: "ann@x.com", Name: "Ann"},
	)
	dfxWantNoChange(t, both, both, dfxUsers())

	tasks := []PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxMilestone(kG, "Deliverable", dfxFri),
	}
	// A milestone the project holds, with a person on it: no row to add, none to
	// remove, and nobody to warn about.
	fileOnly := dfxPlan(tasks, nil, PlanAssign{Task: kG, Email: "ann@x.com", Name: "Ann"})
	dfxWantNoChange(t, dfxPlan(tasks, nil), fileOnly, dfxUsers())
	curOnly := dfxPlan(tasks, nil, PlanAssign{Task: kG, Email: "ann@x.com", Name: "Ann"})
	dfxWantNoChange(t, curOnly, dfxPlan(tasks, nil), dfxUsers())

	// The same for a milestone the file added: its create carries no assignee.
	added := dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxNewMilestone("9", "Ship", dfxFri),
	}, nil, PlanAssign{Task: "new-milestone:9", Email: "ann@x.com", Name: "Ann"})
	changes, warnings := diffPlans(dfxPlan([]PlanTask{dfxTask(kA, "", "Design", dfxMon, 1)}, nil), added, dfxUsers())
	dfxWantKeys(t, changes, "new-milestone:9")
	if len(warnings) != 0 {
		t.Errorf("warnings = %+v, want none", warnings)
	}
}

// TestRemovalDependents counts what goes with a removal, so the row can say
// "has 2 timesheets, 1 risk link, 3 subtasks" before anyone ticks it.
func TestRemovalDependents(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p := f.project(uuid.New(), "everyone")
	parent := f.task(p, nil, nil)
	for range 3 {
		f.task(p, &parent, nil)
	}
	// A soft-deleted subtask is not data a removal loses.
	doomed := f.task(p, &parent, nil)
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, doomed)

	leaf := f.task(p, nil, nil)
	for range 2 {
		f.timesheet(p, parent, 1)
	}
	f.exec(`INSERT INTO project_timesheet (tenant_id, project_id, task_id, user_id, date, hours, deleted_at)
		VALUES ($1, $2, $3, $4, now(), 3, now())`, f.tenant, p, parent, uuid.New())
	f.timesheet(p, leaf, 5)

	risk := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'R', 'quality', 2, 1, 3) RETURNING id`, f.tenant, p)
	other := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'R2', 'cost', 2, 1, 3) RETURNING id`, f.tenant, p)
	f.exec(`INSERT INTO project_risk_task (tenant_id, project_id, risk_id, task_id) VALUES ($1, $2, $3, $4)`,
		f.tenant, p, risk, parent)
	f.exec(`INSERT INTO project_risk_task (tenant_id, project_id, risk_id, task_id, deleted_at)
		VALUES ($1, $2, $3, $4, now())`, f.tenant, p, other, parent)

	stranger := uuid.New()
	got, err := removalDependents(ctx, f.app.DB, f.tenant, []uuid.UUID{parent, leaf, stranger})
	if err != nil {
		t.Fatalf("removalDependents: %v", err)
	}
	// Every requested task gets an entry, so a caller never reads a missing key
	// as a zero it did not ask about.
	if len(got) != 3 {
		t.Errorf("%d entries, want one per requested task", len(got))
	}
	want := Dependents{Subtasks: 3, Timesheets: 2, RiskLinks: 1}
	if got[parent] != want {
		t.Errorf("parent = %+v, want %+v", got[parent], want)
	}
	// A leaf loses no children, but its own timesheet is data its removal takes
	// with it, so the row still has to say so.
	if got[leaf] != (Dependents{Timesheets: 1}) {
		t.Errorf("leaf = %+v, want only its own timesheet counted", got[leaf])
	}
	if entry, ok := got[stranger]; !ok {
		t.Error("an unknown id has no entry")
	} else if entry != (Dependents{}) {
		t.Errorf("unknown id = %+v, want zeroes", entry)
	}

	// Rows of another tenant are not this project's dependents.
	foreign := f.task(p, nil, nil)
	foreignKid := f.task(p, &foreign, nil)
	f.timesheet(p, foreign, 2)
	foreignRisk := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'R3', 'quality', 2, 1, 3) RETURNING id`, f.tenant, p)
	f.exec(`INSERT INTO project_risk_task (tenant_id, project_id, risk_id, task_id) VALUES ($1, $2, $3, $4)`,
		f.tenant, p, foreignRisk, foreign)
	foreignTenant := uuid.New()
	for _, id := range []uuid.UUID{foreign, foreignKid} {
		f.exec(`UPDATE project_task SET tenant_id = $2 WHERE id = $1`, id, foreignTenant)
	}
	f.exec(`UPDATE project_timesheet SET tenant_id = $2 WHERE task_id = $1`, foreign, foreignTenant)
	f.exec(`UPDATE project_risk_task SET tenant_id = $2 WHERE task_id = $1`, foreign, foreignTenant)
	got, err = removalDependents(ctx, f.app.DB, f.tenant, []uuid.UUID{foreign})
	if err != nil {
		t.Fatalf("removalDependents: %v", err)
	}
	if got[foreign] != (Dependents{}) {
		t.Errorf("another tenant's task = %+v, want zeroes", got[foreign])
	}

	// An empty request is not an error: nothing to ask, nothing to count.
	got, err = removalDependents(ctx, f.app.DB, f.tenant, nil)
	if err != nil {
		t.Fatalf("removalDependents with no task: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("%d entries, want none", len(got))
	}
}
