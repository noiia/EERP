package project

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
)

// ── A project that IS one decoded file ───────────────────────────────────────

// exInstallPlan seeds pid with exactly the rows the plan p describes, keeping the
// identities the file carries (a task's eerp_id is the row's id, a milestone's
// milestone:<uuid> the milestone row's id), so a preview of the project against p
// has nothing to do. The apply tests start from a real file rather than from rows
// seeded by hand: the whole feature is about a file's own words describing the
// project, so the fixture must speak the same words.
//
// It writes plain SQL with the ids the file itself supplies and nothing else. It
// shares no code with the importer, so a bug cannot hide behind a helper that makes
// the same mistake twice; the fixture is pinned by its own test, below.
// exReapStale removes what an interrupted run left behind. The fixtures' row ids
// are fixed (the .gan files carry them), so a run killed before its cleanup would
// make every later insert collide. Those ids exist only in tests: a tenant still
// holding one from more than 15 minutes ago (longer than any run) is such a
// leftover, and all of its rows go. A run in progress is never touched.
func exReapStale(t *testing.T, f *fixture, ids []uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	rows, err := f.app.DB.Query(ctx, `SELECT tenant_id FROM project_task WHERE id = ANY($1) AND created_at < now() - interval '15 minutes'
		UNION SELECT tenant_id FROM project_milestone WHERE id = ANY($1) AND created_at < now() - interval '15 minutes'`, ids)
	if err != nil {
		t.Fatalf("stale fixture rows: %v", err)
	}
	var stale []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		if id != f.tenant {
			stale = append(stale, id)
		}
	}
	rows.Close()
	if len(stale) == 0 {
		return
	}
	// Every table with a tenant_id, a few passes so foreign keys resolve in any order
	// (a delete a reference still blocks fails alone and is retried on the next pass).
	tables, err := f.app.DB.Query(ctx, `SELECT DISTINCT table_name FROM information_schema.columns
		WHERE column_name = 'tenant_id' AND table_schema = current_schema()`)
	if err != nil {
		t.Fatalf("tenant tables: %v", err)
	}
	var names []string
	for tables.Next() {
		var n string
		if err := tables.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	tables.Close()
	for pass := 0; pass < 5; pass++ {
		for _, n := range names {
			_, _ = f.app.DB.Exec(ctx, `DELETE FROM "`+strings.ReplaceAll(n, `"`, `""`)+`" WHERE tenant_id = ANY($1)`, stale)
		}
	}
}

func exInstallPlan(t *testing.T, f *fixture, pid uuid.UUID, p Plan) {
	t.Helper()
	ids := make([]uuid.UUID, 0, len(p.Tasks))
	for _, row := range p.Tasks {
		ids = append(ids, exRowID(t, row.Ref))
	}
	exReapStale(t, f, ids)
	for _, row := range p.Tasks {
		if !row.Milestone {
			continue
		}
		f.exec(`INSERT INTO project_milestone (tenant_id, project_id, id, name, deadline)
			VALUES ($1, $2, $3, $4, $5)`,
			f.tenant, pid, exRowID(t, row.Ref), row.Name, exDate(exDayStr(row.Start)))
	}
	for _, row := range p.Tasks {
		if row.Milestone {
			continue
		}
		var parent, milestone any
		switch {
		case strings.HasPrefix(row.Parent, milestoneRefPrefix):
			milestone = exRowID(t, row.Parent)
		case row.Parent != "":
			parent = exRowID(t, row.Parent)
		}
		var start, deadline any
		if !row.Undated {
			start = exDate(exDayStr(row.Start))
			deadline = exDate(exDayStr(endAfter(row.Start, row.Duration, p.Weekend)))
		}
		closed := false
		if row.Complete == 100 {
			closed = true
		}
		f.exec(`INSERT INTO project_task (tenant_id, project_id, id, stage_id, parent_id, milestone_id,
				name, date_start, deadline, planned_hours)
			VALUES ($1, $2, $3,
				(SELECT id FROM project_stage WHERE project_id = $2 AND deleted_at IS NULL AND closed = $7
				 ORDER BY sequence, created_at LIMIT 1),
				$4, $5, $6, $8, $9, $10)`,
			f.tenant, pid, exRowID(t, row.Ref), parent, milestone, row.Name, closed, start, deadline, row.PlannedHours)
	}
	for _, dep := range p.Deps {
		if strings.HasPrefix(dep.Succ, milestoneRefPrefix) {
			// The one shape EERP holds a deliverable link in: the producing task
			// carries the milestone (see readPlanDeps).
			f.exec(`UPDATE project_task SET milestone_id = $2 WHERE id = $1`,
				exRowID(t, dep.Pred), exRowID(t, dep.Succ))
			continue
		}
		f.exec(`INSERT INTO project_task_dependency (tenant_id, project_id, id, task_id, depends_on_id)
			VALUES ($1, $2, $3, $4, $5)`,
			f.tenant, pid, uuid.New(), exRowID(t, dep.Succ), exRowID(t, dep.Pred))
	}
	users := exUsers(t, f)
	for _, a := range p.Assignments {
		id, ok := users[strings.ToLower(a.Email)]
		if !ok {
			t.Fatalf("plan assigns %s to %s, who the staff map does not hold", a.Task, a.Email)
		}
		f.exec(`INSERT INTO project_task_user (tenant_id, project_id, id, task_id, user_id)
			VALUES ($1, $2, $3, $4, $5)`, f.tenant, pid, uuid.New(), exRowID(t, a.Task), id)
	}
}

// exReinstall takes the project's plan rows away and installs p in their place. A
// test that runs the same ticks twice needs the project they were taken out of back
// again, and the file's rows carry their own ids, so the old ones have to go first.
func exReinstall(t *testing.T, f *fixture, pid uuid.UUID, p Plan) {
	t.Helper()
	for _, q := range []string{
		`DELETE FROM project_task_user WHERE tenant_id = $1 AND project_id = $2`,
		`DELETE FROM project_task_dependency WHERE tenant_id = $1 AND project_id = $2`,
		`DELETE FROM project_task_stage WHERE tenant_id = $1 AND project_id = $2`,
		`DELETE FROM project_task WHERE tenant_id = $1 AND project_id = $2`,
		`DELETE FROM project_milestone WHERE tenant_id = $1 AND project_id = $2`,
	} {
		f.exec(q, f.tenant, pid)
	}
	exInstallPlan(t, f, pid, p)
}

// exRowID is the uuid a plan key carries: the bare task id, or the milestone id
// behind the milestone: prefix. A key with no uuid in it (a row the file added) has
// no row to install, which is a misuse of this fixture rather than a silent skip.
func exRowID(t *testing.T, key string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(strings.TrimPrefix(key, milestoneRefPrefix))
	if err != nil {
		t.Fatalf("plan key %q is not an EERP identity, which this fixture cannot install", key)
	}
	return id
}

// exDayStr writes a plan's whole day the way the exchange columns are seeded.
func exDayStr(d time.Time) string { return d.Format(exchangeDayLayout) }

// exWithout is a file with some of its rows taken out, which is how a partner's
// deletion reaches the diff: the whole point is that a row the file no longer names
// is a decision, not a row that was never there.
func exWithout(p Plan, names ...string) Plan {
	out := Plan{Name: p.Name, Weekend: p.Weekend, HasHolidays: p.HasHolidays}
	drop := func(s string) bool { return slices.Contains(names, s) }
	for _, task := range p.Tasks {
		if drop(task.Name) {
			continue
		}
		out.Tasks = append(out.Tasks, task)
	}
	held := map[string]bool{}
	for _, task := range out.Tasks {
		held[task.Key()] = true
	}
	for _, dep := range p.Deps {
		if held[dep.Pred] && held[dep.Succ] {
			out.Deps = append(out.Deps, dep)
		}
	}
	for _, a := range p.Assignments {
		if held[a.Task] {
			out.Assignments = append(out.Assignments, a)
		}
	}
	return out
}

// exRenamed is a file with one row's name changed: the cheapest edit a test can ask
// a partner to have made.
func exRenamed(p Plan, from, to string) Plan {
	out := Plan{Name: p.Name, Weekend: p.Weekend, HasHolidays: p.HasHolidays,
		Tasks: slices.Clone(p.Tasks), Deps: slices.Clone(p.Deps), Assignments: slices.Clone(p.Assignments)}
	for i := range out.Tasks {
		if out.Tasks[i].Name == from {
			out.Tasks[i].Name = to
		}
	}
	return out
}

// ── The calls ────────────────────────────────────────────────────────────────

// exPreview is what the wizard would show for file, and the base the wizard would
// have sent back with the ticked keys: the project read on the FILE's calendar,
// which is the only one whose durations mean the same as the file's.
func exPreview(t *testing.T, f *fixture, pid uuid.UUID, file Plan) (string, []Change, []Warning) {
	t.Helper()
	cur := exLoad(t, f, pid, file.Weekend)
	changes, warnings := diffPlans(cur, file, exUsers(t, f))
	return planHash(cur), changes, warnings
}

// exKeysOf is the key of every row the wizard would list.
func exKeysOf(changes []Change) []string { return dfxKeys(changes) }

// exDefaultKeys is what "apply what is ticked" means: the rows the diff selected,
// and no removal (nothing that destroys data arrives ticked).
func exDefaultKeys(changes []Change) []string {
	var out []string
	for _, c := range changes {
		if c.DefaultSelected {
			out = append(out, c.Key)
		}
	}
	return out
}

// exApply applies keys as who and returns the number of rows applied, failing the
// test on any rejection.
func exApply(t *testing.T, f *fixture, who auth.Identity, pid uuid.UUID, file Plan, name string, keys ...string) int {
	t.Helper()
	n, err := exTryApply(f, who, pid, file, name, keys)
	if err != nil {
		t.Fatalf("applyPlan(%s): %v", strings.Join(keys, " "), err)
	}
	return n
}

// exTryApply is applyPlan as the route calls it (the base and the staff map fresh
// from the project, the caller stamped on the context), with its error handed back.
func exTryApply(f *fixture, who auth.Identity, pid uuid.UUID, file Plan, name string, keys []string) (int, error) {
	base, _, _ := exPreview(f.t, f, pid, file)
	return f.handler().applyPlan(ctxFor(who), who.TenantID, pid, file, base, keys, exUsers(f.t, f), name)
}

// exRejection is err as the route would answer it.
func exRejection(t *testing.T, err error) *rejection {
	t.Helper()
	var rej *rejection
	if !errors.As(err, &rej) {
		t.Fatalf("applyPlan error = %v, want a *rejection", err)
	}
	return rej
}

// exDepKey and exAssignKey build the two keys the diff builds by concatenation. A
// test must not split a key to get one, so it builds them the same way.
func exDepKey(pred, succ string, del bool) string {
	k := "dep:" + pred + ":" + succ
	if del {
		return k + ":delete"
	}
	return k
}

func exAssignKey(task, email string, del bool) string {
	k := "assign:" + task + ":" + email
	if del {
		return k + ":delete"
	}
	return k
}

// ── Reading the project back ─────────────────────────────────────────────────

// exLive is the row still live (a soft delete is the delete here).
func exLive(t *testing.T, f *fixture, table string, id uuid.UUID) bool {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM `+table+`
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, f.tenant).Scan(&n); err != nil {
		t.Fatalf("is %s %s live: %v", table, id, err)
	}
	return n > 0
}

// exColumn is one column of one row, as the database holds it.
func exColumn[T any](t *testing.T, f *fixture, table string, id uuid.UUID, col string) T {
	t.Helper()
	var v T
	if err := f.app.DB.QueryRow(context.Background(), `SELECT `+col+` FROM `+table+`
		WHERE id = $1 AND tenant_id = $2`, id, f.tenant).Scan(&v); err != nil {
		t.Fatalf("%s.%s of %s: %v", table, col, id, err)
	}
	return v
}

// exDepLive is the dependency between two tasks still held?
func exDepLive(t *testing.T, f *fixture, task, dependsOn uuid.UUID) bool {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM project_task_dependency
		WHERE tenant_id = $1 AND task_id = $2 AND depends_on_id = $3 AND deleted_at IS NULL`,
		f.tenant, task, dependsOn).Scan(&n); err != nil {
		t.Fatalf("dependency %s on %s: %v", task, dependsOn, err)
	}
	return n > 0
}

// exAssignLive is the person still on the task?
func exAssignLive(t *testing.T, f *fixture, task, user uuid.UUID) bool {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM project_task_user
		WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
		f.tenant, task, user).Scan(&n); err != nil {
		t.Fatalf("assignment of %s to %s: %v", user, task, err)
	}
	return n > 0
}

// exSiblings is the task names in their position order: the only way to see what the
// position pass did, the plan itself holding no order but the one it was read in.
func exSiblings(t *testing.T, f *fixture, pid uuid.UUID, parent *uuid.UUID) []string {
	t.Helper()
	rows, err := f.app.DB.Query(context.Background(), `SELECT name FROM project_task
		WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL
			AND parent_id IS NOT DISTINCT FROM $3
		ORDER BY sequence, created_at`, f.tenant, pid, parent)
	if err != nil {
		t.Fatalf("siblings: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("siblings scan: %v", err)
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("siblings: %v", err)
	}
	return out
}

// exLog is the project's activity log, which an import writes one line of.
type exLog struct {
	Kind, Body, AuthorEmail string
	AuthorID                uuid.UUID
}

func exLogs(t *testing.T, f *fixture, pid uuid.UUID) []exLog {
	t.Helper()
	rows, err := f.app.DB.Query(context.Background(), `SELECT kind, body, author_id, author_email
		FROM chatter_message WHERE tenant_id = $1 AND table_name = 'project' AND record_id = $2
		ORDER BY created_at, id`, f.tenant, pid)
	if err != nil {
		t.Fatalf("chatter: %v", err)
	}
	defer rows.Close()
	var out []exLog
	for rows.Next() {
		var m exLog
		if err := rows.Scan(&m.Kind, &m.Body, &m.AuthorID, &m.AuthorEmail); err != nil {
			t.Fatalf("chatter scan: %v", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("chatter: %v", err)
	}
	return out
}

// exProject is the pair every apply test starts from: a project whose plan IS
// basic.gan, with the file's own people around it.
type exProject struct {
	f       *fixture
	mgr     uuid.UUID
	pid     uuid.UUID
	basic   Plan
	partner Plan
	ann     uuid.UUID
}

func exFixture(t *testing.T) exProject {
	t.Helper()
	f := newFixture(t)
	basic, _ := ganDecodeFile(t, "basic.gan")
	partner, _ := ganDecodeFile(t, "partner_edited.gan")
	e := exProject{f: f, basic: basic, partner: partner}
	e.ann = exStaff(f, "ann@x.com", "Ann", "Ann", "Lee")
	e.mgr = exStaff(f, "mgr@x.com", "Mgr", "Mgr", "Lee")
	e.pid = f.project(e.mgr, "everyone")
	f.member(e.pid, e.ann)
	exInstallPlan(t, f, e.pid, basic)
	return e
}

// ── The fixture, pinned ──────────────────────────────────────────────────────

// TestApply_InstalledPlanIsTheFile pins the fixture the whole file rests on: the
// project exInstallPlan seeds must be, to the diff, indistinguishable from the file
// it came from. Nothing below means anything if this is not exactly true.
func TestApply_InstalledPlanIsTheFile(t *testing.T) {
	e := exFixture(t)
	_, changes, warnings := exPreview(t, e.f, e.pid, e.basic)
	dfxWantEmpty(t, changes, warnings)
	if _, warns := ganDecodeFile(t, "basic.gan"); len(warns) != 0 {
		t.Fatalf("basic.gan decodes with warnings %+v, so the fixture cannot be the file", warns)
	}
}

// ── Task 7 ───────────────────────────────────────────────────────────────────

// TestApply_Subset: the manager ticks one row and one row happens. The rest of the
// file stays a suggestion, which is the whole promise of the review list.
func TestApply_Subset(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	_, changes, _ := exPreview(t, f, pid, e.partner)
	want := dfxRow(t, changes, changeKey(ganFramingRef, fieldDates))
	if want.DefaultSelected != true {
		t.Fatalf("the dates row arrives unticked, so the wizard's default selection is not what apply follows")
	}

	n := exApply(t, f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", changeKey(ganFramingRef, fieldDates))
	if n != 1 {
		t.Errorf("applied %d rows, want 1", n)
	}

	// The one thing that was ticked.
	framing := uuid.MustParse(ganFramingRef)
	if got := exColumn[*time.Time](t, f, "project_task", framing, "date_start"); got == nil || got.Format(exchangeDayLayout) != "2026-01-19" {
		t.Errorf("Framing starts %v, want 2026-01-19", got)
	}
	if got := exColumn[*time.Time](t, f, "project_task", framing, "deadline"); got == nil || got.Format(exchangeDayLayout) != "2026-01-26" {
		t.Errorf("Framing ends %v, want 2026-01-26 (six working days)", got)
	}

	// Everything the unticked rows would have done.
	concrete := uuid.MustParse(ganConcreteRef)
	if !exLive(t, f, "project_task", concrete) {
		t.Error("Concrete pour was deleted, though its removal was never ticked")
	}
	if !exDepLive(t, f, framing, concrete) {
		t.Error("the dependency Concrete pour → Framing was deleted, though its removal was never ticked")
	}
	if n := exCountNamed(t, f, "Safety inspection"); n != 0 {
		t.Errorf("the file's new task was created %d times, though its create was never ticked", n)
	}
	if !exAssignLive(t, f, framing, e.ann) {
		t.Error("Ann was taken off Framing, though no row asked for it")
	}
	if _, changes, _ := exPreview(t, f, pid, e.partner); len(dfxKeys(changes)) != 4 {
		t.Errorf("rows left to apply = %s, want the four nobody ticked", strings.Join(dfxKeys(changes), " "))
	}
}

func exCountNamed(t *testing.T, f *fixture, name string) int {
	t.Helper()
	return exCountRows(t, f, "project_task", name)
}

// exCountRows counts the live rows of one table under one name, which is how a test asks
// whether a batch it expects to be refused wrote anything at all.
func exCountRows(t *testing.T, f *fixture, table, name string) int {
	t.Helper()
	var n int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM `+table+`
		WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`, f.tenant, name).Scan(&n); err != nil {
		t.Fatalf("count %s named %s: %v", table, name, err)
	}
	return n
}

// TestApply_ThenPreviewIsEmpty (Review Focus 2): what apply did must not come back
// as something to do again, or the wizard lies twice.
//
// Two things have to hold, and they are not the same thing. Applying the manager's
// whole selection has to leave a project that agrees with the file about everything
// it was told (the first subtest: only the rows about the one row the file cannot
// name survive, and no field, move or people row at all). And what EERP writes out
// has to come back as nothing to do (the second: export, encode, decode, diff),
// which is the round trip a manager actually repeats.
func TestApply_ThenPreviewIsEmpty(t *testing.T) {
	t.Run("whole_selection_leaves_only_the_unnameable", func(t *testing.T) {
		e := exFixture(t)
		f, pid := e.f, e.pid
		_, first, _ := exPreview(t, f, pid, e.partner)
		n := exApply(t, f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", exKeysOf(first)...)
		if n != len(first) {
			t.Errorf("applied %d rows, want all %d", n, len(first))
		}

		_, again, _ := exPreview(t, f, pid, e.partner)
		// The created task, which the file has no eerp_id for: it can never match,
		// so its create, its dependency and the two removals they imply are all the
		// file still has to say about itself.
		created := exRowByName(t, f, "project_task", "Safety inspection")
		want := []string{
			"new:7",
			exDepKey(ganFramingRef, "new:7", false),
			changeKey(created.String(), "delete"),
			exDepKey(ganFramingRef, created.String(), true),
		}
		got := slices.Clone(dfxKeys(again))
		slices.Sort(got)
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("rows left = %s, want %s", strings.Join(got, " "), strings.Join(want, " "))
		}
		// Nothing a field, a position or a person may survive an apply of everything.
		for _, kind := range []string{kindUpdate, kindMove, kindAssign, kindAssignDelete,
			kindMilestoneCreate, kindMilestoneUpdate, kindMilestoneDelete} {
			if c := dfxCount(again, kind); c != 0 {
				t.Errorf("%d %s rows left, want none: %s", c, kind, strings.Join(dfxKeys(again), " "))
			}
		}
	})

	t.Run("what_eerp_writes_comes_back_as_nothing_to_do", func(t *testing.T) {
		e := exFixture(t)
		f, pid := e.f, e.pid
		_, first, _ := exPreview(t, f, pid, e.partner)
		exApply(t, f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", exKeysOf(first)...)

		var buf bytes.Buffer
		if err := (ganFormat{}).Encode(&buf, exExport(t, f, pid)); err != nil {
			t.Fatalf("Encode: %v", err)
		}
		written, warns, err := ganFormat{}.Decode(&buf)
		if err != nil {
			t.Fatalf("Decode(what we wrote): %v", err)
		}
		if len(warns) != 0 {
			t.Errorf("our own file decodes with warnings %+v", warns)
		}
		_, changes, warnings := exPreview(t, f, pid, written)
		dfxWantEmpty(t, changes, warnings)
	})

	t.Run("unticked_removals_reappear_identically", func(t *testing.T) {
		e := exFixture(t)
		f, pid := e.f, e.pid
		_, first, _ := exPreview(t, f, pid, e.partner)
		var unticked []string
		for _, c := range first {
			if !c.DefaultSelected {
				unticked = append(unticked, c.Key)
			}
		}
		if len(unticked) == 0 {
			t.Fatal("the file offers no removal, so this test would prove nothing")
		}
		exApply(t, f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", exDefaultKeys(first)...)

		_, again, _ := exPreview(t, f, pid, e.partner)
		for _, key := range unticked {
			row := dfxRow(t, again, key)
			if row.DefaultSelected {
				t.Errorf("row %s came back ticked; a removal nobody ticked must stay unticked", key)
			}
		}
	})
}

func exRowByName(t *testing.T, f *fixture, table, name string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.app.DB.QueryRow(context.Background(), `SELECT id FROM `+table+`
		WHERE tenant_id = $1 AND name = $2 AND deleted_at IS NULL`, f.tenant, name).Scan(&id); err != nil {
		t.Fatalf("%s named %s: %v", table, name, err)
	}
	return id
}

// TestApply_StaleBase409: the manager reviews a file, a colleague edits the project
// underneath them, and the apply must refuse rather than overwrite the colleague's
// work with a preview of a project that no longer exists.
func TestApply_StaleBase409(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	key := changeKey(ganFramingRef, fieldDates)

	// A base from a project state that used to exist: the colleague moved Excavation
	// while the manager was reading the wizard.
	stale, _, _ := exPreview(t, f, pid, e.basic)
	f.exec(`UPDATE project_task SET planned_hours = 5 WHERE id = $1`, uuid.MustParse(ganExcavationRef))
	_, err := f.handler().applyPlan(ctxFor(f.caller(e.mgr)), f.tenant, pid, e.partner, stale,
		[]string{key}, exUsers(t, f), "partner_edited.gan")
	rej := exRejection(t, err)
	if rej.status != http.StatusConflict || rej.code != "PROJECT_CHANGED" {
		t.Fatalf("stale base: %d %s, want 409 PROJECT_CHANGED", rej.status, rej.code)
	}
	if got := exColumn[*time.Time](t, f, "project_task", uuid.MustParse(ganFramingRef), "date_start"); got == nil ||
		got.Format(exchangeDayLayout) != "2026-01-12" {
		t.Errorf("the refused apply still moved Framing: %v", got)
	}

	// And the same base is refused a second time once the apply has gone through:
	// the hash really does move when the project changes.
	fresh, _, _ := exPreview(t, f, pid, e.partner)
	exApply(t, f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", key)
	_, err = f.handler().applyPlan(ctxFor(f.caller(e.mgr)), f.tenant, pid, e.partner, fresh,
		[]string{key}, exUsers(t, f), "partner_edited.gan")
	if rej := exRejection(t, err); rej.status != http.StatusConflict || rej.code != "PROJECT_CHANGED" {
		t.Fatalf("replaying a spent base: %d %s, want 409 PROJECT_CHANGED", rej.status, rej.code)
	}
}

// TestApply_MissingRequires422 (Review Focus 3): a dependency on a task the file
// added cannot exist without that task, so the selection is refused, naming both
// rows the manager has to tick.
func TestApply_MissingRequires422(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	_, changes, _ := exPreview(t, f, pid, e.partner)
	dep := dfxRow(t, changes, exDepKey(ganFramingRef, "new:7", false))
	if !slices.Contains(dep.Requires, "new:7") {
		t.Fatalf("the dependency row carries requires %v, want new:7 among them", dep.Requires)
	}

	_, err := exTryApply(f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", []string{dep.Key})
	rej := exRejection(t, err)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("a dependency without its create: %d %s, want 422", rej.status, rej.code)
	}
	for _, want := range []string{dep.Key, "new:7"} {
		if !slices.Contains(rej.fields, want) {
			t.Errorf("fields = %v, want %s named", rej.fields, want)
		}
	}
	if n := exCountNamed(t, f, "Safety inspection"); n != 0 {
		t.Errorf("the refused apply created the task anyway (%d)", n)
	}
}

// TestApply_ParentDeleteWithoutChildren422 (Review Focus 3): deleting a summary while
// its subtasks stay leaves rows whose parent the plan cannot hold. The diff names the
// children the removal needs, and apply refuses to carry out half of it.
func TestApply_ParentDeleteWithoutChildren422(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	// The partner deleted Foundation and Excavation but kept Concrete pour under it.
	file := exWithout(e.basic, "Foundation", "Excavation")
	_, changes, _ := exPreview(t, f, pid, file)
	parent := dfxRow(t, changes, changeKey(ganFoundationRef, "delete"))
	wantChild := changeKey(ganExcavationRef, "delete")
	if !slices.Contains(parent.Requires, wantChild) {
		t.Fatalf("the parent removal requires %v, want %s", parent.Requires, wantChild)
	}

	_, err := exTryApply(f, f.caller(e.mgr), pid, file, "half.gan", []string{parent.Key})
	rej := exRejection(t, err)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("a parent deleted alone: %d %s, want 422", rej.status, rej.code)
	}
	for _, want := range []string{parent.Key, wantChild} {
		if !slices.Contains(rej.fields, want) {
			t.Errorf("fields = %v, want %s named", rej.fields, want)
		}
	}
	foundation, excavation := uuid.MustParse(ganFoundationRef), uuid.MustParse(ganExcavationRef)
	if !exLive(t, f, "project_task", foundation) {
		t.Error("the refused apply deleted Foundation")
	}
	if !exLive(t, f, "project_task", excavation) {
		t.Error("the refused apply deleted Excavation")
	}

	// With both ticked, the whole subtree goes.
	n := exApply(t, f, f.caller(e.mgr), pid, file, "half.gan", parent.Key, wantChild)
	if n < 2 {
		t.Errorf("applied %d rows, want at least the two removals", n)
	}
	if exLive(t, f, "project_task", foundation) || exLive(t, f, "project_task", excavation) {
		t.Error("the two removals were not applied")
	}
	if !exLive(t, f, "project_task", uuid.MustParse(ganConcreteRef)) {
		t.Error("Concrete pour went with them, though its own removal was never ticked")
	}
}

// TestApply_CycleIs422WithKey: the rules EERP runs on every ordinary write must run
// here too, and the 422 must name the row the manager ticked, not a column name they
// have never seen.
func TestApply_CycleIs422WithKey(t *testing.T) {
	t.Run("dependency", func(t *testing.T) {
		e := exFixture(t)
		f, pid := e.f, e.pid
		// The plan already holds "Concrete pour finishes before Framing starts"; the
		// file asks for the link the other way round, which would close a loop.
		file := e.basic
		file.Deps = slices.Clone(e.basic.Deps)
		file.Deps = append(file.Deps, PlanDep{Pred: ganFramingRef, Succ: ganConcreteRef, Type: DepFS})
		_, changes, _ := exPreview(t, f, pid, file)
		key := exDepKey(ganFramingRef, ganConcreteRef, false)
		dfxRow(t, changes, key)

		_, err := exTryApply(f, f.caller(e.mgr), pid, file, "loop.gan", []string{key})
		rej := exRejection(t, err)
		if rej.status != http.StatusUnprocessableEntity {
			t.Fatalf("a cyclic dependency: %d %s, want 422", rej.status, rej.code)
		}
		if !slices.Equal(rej.fields, []string{key}) {
			t.Errorf("fields = %v, want [%s]", rej.fields, key)
		}
		if !strings.Contains(rej.msg, "cycle") {
			t.Errorf("message %q, want the dependency rule's own words about a cycle", rej.msg)
		}
		if exDepLive(t, f, uuid.MustParse(ganConcreteRef), uuid.MustParse(ganFramingRef)) {
			t.Error("the cyclic dependency was written anyway")
		}
	})

	t.Run("parent", func(t *testing.T) {
		e := exFixture(t)
		f, pid := e.f, e.pid
		file := e.basic
		file.Tasks = slices.Clone(e.basic.Tasks)
		for i := range file.Tasks {
			if file.Tasks[i].Name == "Foundation" {
				// The partner hung a task under its own child.
				file.Tasks[i].Parent = ganExcavationRef
			}
		}
		_, changes, _ := exPreview(t, f, pid, file)
		key := changeKey(ganFoundationRef, "move")
		dfxRow(t, changes, key)

		_, err := exTryApply(f, f.caller(e.mgr), pid, file, "loop.gan", []string{key})
		rej := exRejection(t, err)
		if rej.status != http.StatusUnprocessableEntity {
			t.Fatalf("a task hung under its own child: %d %s, want 422", rej.status, rej.code)
		}
		if !slices.Equal(rej.fields, []string{key}) {
			t.Errorf("fields = %v, want [%s]", rej.fields, key)
		}
		if !strings.Contains(rej.msg, "parent") {
			t.Errorf("message %q, want the task rule's own words about a parent cycle", rej.msg)
		}
		if got := exColumn[*uuid.UUID](t, f, "project_task", uuid.MustParse(ganFoundationRef), "parent_id"); got != nil {
			t.Errorf("Foundation's parent is %s, want it untouched", got)
		}
	})
}

// TestApply_AllOrNothing: one row the rules refuse in the middle of a batch must
// leave the project exactly as it was, log line included.
func TestApply_AllOrNothing(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	// The project holds one dependency the file knows nothing about: Framing waits
	// for Excavation. The file asks for the same link the other way round, and
	// the rules refuse it (it would close a loop) after the other rows were written.
	f.dependency(pid, uuid.MustParse(ganFramingRef), uuid.MustParse(ganExcavationRef))
	file := e.partner
	file.Deps = append(slices.Clone(e.partner.Deps),
		PlanDep{Pred: ganFramingRef, Succ: ganExcavationRef, Type: DepFS})
	_, changes, _ := exPreview(t, f, pid, file)
	keys := exKeysOf(changes)
	if len(keys) < 6 {
		t.Fatalf("the preview holds %d rows; the test needs a batch with several writes before the bad one", len(keys))
	}

	_, err := exTryApply(f, f.caller(e.mgr), pid, file, "all-or-nothing.gan", keys)
	rej := exRejection(t, err)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("a batch with one refused row: %d %s, want 422", rej.status, rej.code)
	}

	// The project is the file it was (its own dependency included, which the file
	// never named and the rolled back batch never removed): nothing reached the
	// database.
	was := e.basic
	was.Deps = append(slices.Clone(e.basic.Deps),
		PlanDep{Pred: ganExcavationRef, Succ: ganFramingRef, Type: DepFS})
	_, same, warns := exPreview(t, f, pid, was)
	dfxWantEmpty(t, same, warns)
	if logs := exLogs(t, f, pid); len(logs) != 0 {
		t.Errorf("a rolled-back import logged %d chatter lines, want none: %+v", len(logs), logs)
	}
}

// TestApply_MilestoneDeleteClearsLinks: EERP holds a deliverable link on the task, not
// on the milestone, so deleting the milestone has to take the links with it. The task
// is left alone, its milestone_id simply no longer naming a row.
func TestApply_MilestoneDeleteClearsLinks(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	file := exWithout(e.basic, "Structure approved")
	_, changes, _ := exPreview(t, f, pid, file)
	key := changeKey(ganStructureRef, "delete")
	dfxRow(t, changes, key)
	// The clearing row is offered too, and unticked: two decisions, not one.
	if row := dfxRow(t, changes, changeKey(ganFramingRef, fieldMilestoneID)); row.DefaultSelected {
		t.Error("the deliverable clearing arrives ticked, want unticked")
	}

	exApply(t, f, f.caller(e.mgr), pid, file, "no-gate.gan", key)

	if exLive(t, f, "project_milestone", uuid.MustParse(strings.TrimPrefix(ganStructureRef, milestoneRefPrefix))) {
		t.Error("the milestone is still live")
	}
	if got := exColumn[*uuid.UUID](t, f, "project_task", uuid.MustParse(ganFramingRef), "milestone_id"); got != nil {
		t.Errorf("Framing still produces milestone %s, a row that no longer exists", got)
	}
	if !exLive(t, f, "project_task", uuid.MustParse(ganFramingRef)) {
		t.Error("deleting the deliverable deleted the task that produced it")
	}
}

// TestApply_ClosedMovesStage: a task is closed by the stage it sits in, so an import
// that closes one moves it between columns, the way dragging its card would.
func TestApply_ClosedMovesStage(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	excavation := uuid.MustParse(ganExcavationRef)
	closeFile := exCompleted(t, e.basic, "Excavation", 100)
	key := changeKey(ganExcavationRef, fieldClosed)

	_, changes, _ := exPreview(t, f, pid, closeFile)
	dfxRow(t, changes, key)
	exApply(t, f, f.caller(e.mgr), pid, closeFile, "closed.gan", key)

	if got := exColumn[uuid.UUID](t, f, "project_task", excavation, "stage_id"); got != f.stage(pid, "Done") {
		t.Errorf("Excavation's stage is %s, want Done (%s)", got, f.stage(pid, "Done"))
	}
	if !exColumn[bool](t, f, "project_task", excavation, "closed") {
		t.Error("the closed mirror was not kept with the stage")
	}

	// And back: the file no longer says it is done.
	openFile := exCompleted(t, e.basic, "Excavation", 0)
	exApply(t, f, f.caller(e.mgr), pid, openFile, "reopened.gan", changeKey(ganExcavationRef, fieldClosed))
	if got := exColumn[uuid.UUID](t, f, "project_task", excavation, "stage_id"); got != f.stage(pid, "New") {
		t.Errorf("after the reopening Excavation's stage is %s, want New (%s)", got, f.stage(pid, "New"))
	}
	if exColumn[bool](t, f, "project_task", excavation, "closed") {
		t.Error("the task is still marked closed in an open stage")
	}

	// A project with no column to close into: the row is refused, naming itself.
	f.exec(`UPDATE project_stage SET closed = false WHERE project_id = $1 AND tenant_id = $2`, pid, f.tenant)
	_, changes, _ = exPreview(t, f, pid, closeFile)
	_, err := exTryApply(f, f.caller(e.mgr), pid, closeFile, "closed.gan", []string{key})
	rej := exRejection(t, err)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("closing with no closed stage: %d %s, want 422", rej.status, rej.code)
	}
	if !slices.Contains(rej.fields, key) {
		t.Errorf("fields = %v, want %s named", rej.fields, key)
	}
}

// exCompleted is a file that says one task is (or is not) done.
func exCompleted(t *testing.T, p Plan, name string, complete int) Plan {
	t.Helper()
	out := Plan{Name: p.Name, Weekend: p.Weekend, HasHolidays: p.HasHolidays,
		Tasks: slices.Clone(p.Tasks), Deps: slices.Clone(p.Deps), Assignments: slices.Clone(p.Assignments)}
	for i := range out.Tasks {
		if out.Tasks[i].Name == name {
			out.Tasks[i].Complete = complete
		}
	}
	return out
}

// TestApply_ChatterLog: an import that changes twelve tasks is twelve decisions nobody
// can attribute afterwards unless the project says so itself.
func TestApply_ChatterLog(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	_, changes, _ := exPreview(t, f, pid, e.partner)
	keys := exDefaultKeys(changes)
	if len(keys) != 3 {
		t.Fatalf("the file's default selection is %s, want the three rows the wizard ticks", strings.Join(keys, " "))
	}
	n := exApply(t, f, f.caller(e.mgr), pid, e.partner, "partner_edited.gan", keys...)
	if n != len(keys) {
		t.Fatalf("applied %d rows, want %d", n, len(keys))
	}

	logs := exLogs(t, f, pid)
	if len(logs) != 1 {
		t.Fatalf("the import left %d chatter lines, want exactly one: %+v", len(logs), logs)
	}
	got := logs[0]
	if got.Kind != "log" {
		t.Errorf("kind = %q, want log", got.Kind)
	}
	if want := "Imported partner_edited.gan: 3 changes"; got.Body != want {
		t.Errorf("body = %q, want %q", got.Body, want)
	}
	if got.AuthorID != e.mgr {
		t.Errorf("author = %s, want the caller %s", got.AuthorID, e.mgr)
	}
	if got.AuthorEmail != "mgr@x.com" {
		t.Errorf("author email = %q, want the caller's", got.AuthorEmail)
	}

	// Nothing applied, nothing to say.
	if n := exApply(t, f, f.caller(e.mgr), pid, e.partner, "nothing.gan"); n != 0 {
		t.Errorf("applying no keys returned %d, want 0", n)
	}
	if logs := exLogs(t, f, pid); len(logs) != 1 {
		t.Errorf("an import of nothing logged %d lines, want the one from before", len(logs))
	}
}

// TestApply_UnknownKey422: a key the preview never offered (a stale wizard, or a hand
// built request) is refused by name before anything is written.
func TestApply_UnknownKey422(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	_, err := exTryApply(f, f.caller(e.mgr), pid, e.partner, "bogus.gan",
		[]string{"task:00000000-0000-0000-0000-000000000000:dates"})
	rej := exRejection(t, err)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("an unknown key: %d %s, want 422", rej.status, rej.code)
	}
	if !slices.Contains(rej.fields, "task:00000000-0000-0000-0000-000000000000:dates") {
		t.Errorf("fields = %v, want the key named", rej.fields)
	}
	_, same, warns := exPreview(t, f, pid, e.basic)
	dfxWantEmpty(t, same, warns)
}

// TestApply_DeletedTaskIsNoOp: the rows of one batch are the manager's ticks, and no
// ordering of them is their fault. A task ticked off along with its own deliverable
// clearing must not turn into a 404 about a row that is being deleted anyway, and the
// batch must leave no trace of a write it dropped: the row keeps the deliverable EERP
// still holds on it, and the count the wizard and the log line report is the one delete.
//
// The deliverable clearing is the only write a batch can ever aim at a doomed row (a row
// the file lost has no field, position or completion row of its own: those need the file
// to hold the row), so it is the row that pins the guard. The milestone itself is NOT
// ticked for removal: with the milestone gone, removeMilestones clears the column on its
// own and the write the guard dropped would be invisible either way.
func TestApply_DeletedTaskIsNoOp(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	// The partner deleted Framing but kept the milestone it produced.
	file := exWithout(e.basic, "Framing")
	steps := []string{
		changeKey(ganFramingRef, fieldMilestoneID), // a write against the doomed task
		changeKey(ganFramingRef, "delete"),
	}
	_, changes, _ := exPreview(t, f, pid, file)
	for _, k := range steps {
		dfxRow(t, changes, k)
	}
	framing, gate := uuid.MustParse(ganFramingRef), uuid.MustParse(strings.TrimPrefix(ganStructureRef, milestoneRefPrefix))
	if got := exColumn[*uuid.UUID](t, f, "project_task", framing, "milestone_id"); got == nil || *got != gate {
		t.Fatalf("the fixture's doomed task does not produce the milestone, so this test would prove nothing")
	}

	// Every order of the same ticks must land in the same place. Each one runs on the
	// project as the manager saw it: a second batch on an already emptied project
	// would have nothing left to do, which answers a different question.
	for _, order := range [][]string{steps, {steps[1], steps[0]}} {
		exReinstall(t, f, pid, e.basic)
		n := exApply(t, f, f.caller(e.mgr), pid, file, "gone.gan", order...)
		if exLive(t, f, "project_task", framing) {
			t.Fatalf("Framing survived the ticks %s", strings.Join(order, " "))
		}
		if !exLive(t, f, "project_milestone", gate) {
			t.Fatalf("the milestone went with Framing though its removal was never ticked, ticks %s", strings.Join(order, " "))
		}
		// The dropped write left nothing behind: the row is deleted, but it is deleted
		// holding the deliverable it had, and only the delete counted as a change.
		if got := exColumn[*uuid.UUID](t, f, "project_task", framing, "milestone_id"); got == nil || *got != gate {
			t.Errorf("the batch wrote the deliverable clearing to the doomed task: milestone_id = %v, want %s (ticks %s)",
				got, gate, strings.Join(order, " "))
		}
		if n != 1 {
			t.Errorf("applied %d rows, want the one delete (the write against a doomed row is dropped, not counted), ticks %s",
				n, strings.Join(order, " "))
		}
	}
}

// TestApply_PositionFollowsTheFile: a file that reorders a parent's children is a
// decision about position, and the triggers must land the rows in the file's order
// rather than append the mover at the end.
func TestApply_PositionFollowsTheFile(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	// The partner swapped Foundation's two children: pre-order kept, order swapped.
	b := e.basic.Tasks
	file := e.basic
	file.Tasks = []PlanTask{b[0], b[2], b[1], b[3], b[4], b[5]}

	_, changes, _ := exPreview(t, f, pid, file)
	key := changeKey(ganConcreteRef, "move")
	dfxRow(t, changes, key)
	if got := dfxCount(changes, kindMove); got != 1 {
		t.Fatalf("%d move rows for a swapped pair, want 1: %s", got, strings.Join(dfxKeys(changes), " "))
	}

	// The project starts Excavation, Concrete pour.
	if got, want := exSiblings(t, f, pid, ptrTo(uuid.MustParse(ganFoundationRef))), []string{"Excavation", "Concrete pour"}; !slices.Equal(got, want) {
		t.Fatalf("before: siblings = %s, want %s", strings.Join(got, ", "), strings.Join(want, ", "))
	}
	n := exApply(t, f, f.caller(e.mgr), pid, file, "swapped.gan", key)
	if n != 1 {
		t.Errorf("applied %d rows, want 1", n)
	}
	got, want := exSiblings(t, f, pid, ptrTo(uuid.MustParse(ganFoundationRef))), []string{"Concrete pour", "Excavation"}
	if !slices.Equal(got, want) {
		t.Errorf("after: siblings = %s, want %s", strings.Join(got, ", "), strings.Join(want, ", "))
	}
}

func ptrTo[T any](v T) *T { return &v }

// ── A pair the file adds together ───────────────────────────────────────────

// exAddsGate is a file that adds a deliverable AND the task that produces it, both with
// the file's own ids and no eerp_id: the pair a partner draws when they plan a handover.
// It is the one selection the phase order cannot carry out in one pass, because the task
// create (phase 1) names a milestone this batch writes in phase 2, and the diff knows it
// (the create carries the deliverable inside itself and Requires the milestone's create).
//
// The task also waits on a task of the project, so the same batch resolves a new task and
// a new milestone through the two keys the diff builds by concatenation.
func exAddsGate(p Plan) Plan {
	out := Plan{Name: p.Name, Weekend: p.Weekend, HasHolidays: p.HasHolidays,
		Assignments: slices.Clone(p.Assignments)}
	var tasks, gates []PlanTask
	for _, task := range p.Tasks {
		if task.Milestone {
			gates = append(gates, task)
			continue
		}
		tasks = append(tasks, task)
	}
	// A plan's own order: the tasks in document order, the milestones last.
	tasks = append(tasks, dfxNew("8", "", "Punch list", "2026-02-09", 2))
	gates = append(gates, dfxNewMilestone("9", "Site handover", "2026-02-16"))
	out.Tasks = append(tasks, gates...)
	out.Deps = append(slices.Clone(p.Deps),
		PlanDep{Pred: ganFramingRef, Succ: "new:8", Type: DepFS},
		PlanDep{Pred: "new:8", Succ: "new-milestone:9", Type: DepFS})
	return out
}

// TestApply_NewTaskNamingANewMilestone (Review Focus 2): a file that adds a deliverable
// and the task naming it is the ordinary case, not an error. The task goes in first (the
// brief's order), the milestone next, and the link between them lands with the pair; what
// EERP wrote then comes back as nothing to do.
func TestApply_NewTaskNamingANewMilestone(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	file := exAddsGate(e.basic)
	_, changes, warns := exPreview(t, f, pid, file)
	if len(warns) != 0 {
		t.Fatalf("the pair previews with warnings %+v, want a file EERP can read", warns)
	}
	exWantGatePair(t, changes)

	dep := exDepKey(ganFramingRef, "new:8", false)
	if !dfxRow(t, changes, dep).DefaultSelected {
		t.Error("the dependency the file adds arrives unticked, want the wizard to tick a create")
	}
	n := exApply(t, f, f.caller(e.mgr), pid, file, "handover.gan", "new:8", "new-milestone:9", dep)
	if n != 3 {
		t.Errorf("applied %d rows, want the task, the deliverable and the dependency", n)
	}

	written := exRowByName(t, f, "project_milestone", "Site handover")
	created := exRowByName(t, f, "project_task", "Punch list")
	exWantGateWritten(t, f, created, written)
	exWantWrittenFileIsClean(t, f, pid)
	exWantOnlyUnnameableRows(t, f, pid, file, created, written)
}

// exWantGatePair is what the wizard must offer for a file that adds a deliverable and
// the task naming it: the two creates, ticked, the task's create asking for the
// milestone's, and nothing else of the sort.
func exWantGatePair(t *testing.T, changes []Change) {
	t.Helper()
	task := dfxRow(t, changes, "new:8")
	gate := dfxRow(t, changes, "new-milestone:9")
	if task.Kind != kindCreate || gate.Kind != kindMilestoneCreate {
		t.Fatalf("the pair arrived as %s and %s, want a task create and a milestone create", task.Kind, gate.Kind)
	}
	if !task.DefaultSelected || !gate.DefaultSelected {
		t.Error("the pair arrives unticked, want the wizard to tick both creates")
	}
	if !slices.Contains(task.Requires, "new-milestone:9") {
		t.Fatalf("the task create requires %v, want the deliverable it names", task.Requires)
	}
	if got := dfxCount(changes, kindMilestoneCreate); got != 1 {
		t.Fatalf("%d milestone creates, want 1: %s", got, strings.Join(dfxKeys(changes), " "))
	}
}

// exWantGateWritten is the pair as the database must hold it: both rows live, the
// deliverable on the file's own day, and the task producing it.
func exWantGateWritten(t *testing.T, f *fixture, created, written uuid.UUID) {
	t.Helper()
	if !exLive(t, f, "project_milestone", written) {
		t.Fatal("the deliverable the file added is not live")
	}
	if got := exColumn[time.Time](t, f, "project_milestone", written, "deadline"); !got.Equal(dfxDay("2026-02-16")) {
		t.Errorf("the deliverable is due %v, want 2026-02-16 (the file's own day)", got)
	}
	if got := exColumn[*uuid.UUID](t, f, "project_task", created, "milestone_id"); got == nil || *got != written {
		t.Errorf("Punch list produces %v, want the milestone this batch created (%s)", got, written)
	}
	if !exDepLive(t, f, created, uuid.MustParse(ganFramingRef)) {
		t.Error("the dependency Framing → Punch list was not written, though its create was ticked")
	}
}

// exWantWrittenFileIsClean is the chain a manager repeats: the file EERP writes out of
// what it just holds comes back as nothing to do. It is the exported file that can name
// the pair, the partner's having no eerp_id for either row.
func exWantWrittenFileIsClean(t *testing.T, f *fixture, pid uuid.UUID) {
	t.Helper()
	var buf bytes.Buffer
	if err := (ganFormat{}).Encode(&buf, exExport(t, f, pid)); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	writtenPlan, warns, err := ganFormat{}.Decode(&buf)
	if err != nil {
		t.Fatalf("Decode(what we wrote): %v", err)
	}
	if len(warns) != 0 {
		t.Errorf("our own file decodes with warnings %+v", warns)
	}
	_, again, warns := exPreview(t, f, pid, writtenPlan)
	dfxWantEmpty(t, again, warns)
}

// exWantOnlyUnnameableRows: re-previewing the partner's own file still has nothing to
// say about any row EERP holds. What survives is only about the two rows the file cannot
// name (it gave them no eerp_id), exactly as TestApply_ThenPreviewIsEmpty documents for
// one new row.
func exWantOnlyUnnameableRows(t *testing.T, f *fixture, pid uuid.UUID, file Plan, created, written uuid.UUID) {
	t.Helper()
	_, same, _ := exPreview(t, f, pid, file)
	for _, c := range same {
		about := strings.Contains(c.Key, created.String()) || strings.Contains(c.Key, written.String()) ||
			strings.Contains(c.Key, "new:8") || strings.Contains(c.Key, "new-milestone:9")
		if !about {
			t.Errorf("row %s is left to do though it is about no row the file cannot name: %s",
				c.Key, strings.Join(dfxKeys(same), " "))
		}
	}
}

// TestApply_NewTaskWithoutItsMilestone422: the same pair, but the manager unticks the
// deliverable. The task names a row this batch will never write, and the batch is
// refused before a single write: a 422 whose fields name both rows, nothing created, the
// project untouched. The diff put the milestone's create in the task create's Requires
// for exactly this, and the half the selection cannot see (a deliverable key that names
// no row at all by the time the link is written) is pinned in TestApply_BadRowValueIsRejection.
func TestApply_NewTaskWithoutItsMilestone422(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	file := exAddsGate(e.basic)
	_, changes, _ := exPreview(t, f, pid, file)
	task := dfxRow(t, changes, "new:8")
	if !slices.Contains(task.Requires, "new-milestone:9") {
		t.Fatalf("the create requires %v, want the deliverable it names", task.Requires)
	}

	_, err := exTryApply(f, f.caller(e.mgr), pid, file, "handover.gan", []string{"new:8"})
	rej := exRejection(t, err)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("a task without the deliverable it names: %d %s, want 422", rej.status, rej.code)
	}
	for _, want := range []string{"new:8", "new-milestone:9"} {
		if !slices.Contains(rej.fields, want) {
			t.Errorf("fields = %v, want %s named", rej.fields, want)
		}
	}
	if n := exCountNamed(t, f, "Punch list"); n != 0 {
		t.Errorf("the refused apply created the task %d times", n)
	}
	if n := exCountRows(t, f, "project_milestone", "Site handover"); n != 0 {
		t.Errorf("the refused apply created the deliverable %d times", n)
	}
	_, same, warns := exPreview(t, f, pid, e.basic)
	dfxWantEmpty(t, same, warns)
}

// TestApply_BadRowValueIsRejection: applyPlan's errors are the 409 or a 422 naming the
// ticked rows, and nothing else. The rows here are shapes the diff would never build (it
// makes every After and Before itself), so they stand for a hand built request: each must
// still come back as the row the manager has to untick, never as a plain error the route
// answers 500 with no row named.
func TestApply_BadRowValueIsRejection(t *testing.T) {
	const key = "task:11111111-1111-4111-8111-111111111111:dates"
	a := &applier{}
	cases := []struct {
		name string
		call func() error
	}{
		{"hours", func() error { _, err := a.fieldBody(Change{Key: key, Field: fieldHours, After: "8"}); return err }},
		{"name", func() error { _, err := a.nameOf(Change{Key: key, Field: fieldName, After: 8.0}); return err }},
		{"dates", func() error {
			_, err := a.datesOf(Change{Key: key, Field: fieldDates, After: "2026-02-09"})
			return err
		}},
		{"deadline", func() error { _, err := a.deadlineOf(Change{Key: key, Field: fieldDates, After: 0}); return err }},
		{"completion", func() error { _, err := a.stageOf(Change{Key: key, Field: fieldClosed, After: 100}); return err }},
		{"dependency", func() error { return a.addDependency(Change{Key: key, After: "new:8"}) }},
		{"assignment", func() error { return a.addAssignee(Change{Key: key, After: "ann@x.com"}) }},
		{"removed dependency", func() error {
			b := &applier{rows: []Change{{Key: key, Kind: kindDependencyDelete, Before: "new:8"}},
				want: map[string]bool{key: true}}
			return b.removeDependencies()
		}},
		{"removed assignment", func() error {
			b := &applier{rows: []Change{{Key: key, Kind: kindAssignDelete, Before: "ann@x.com"}},
				want: map[string]bool{key: true}}
			return b.removeAssignees()
		}},
		{"parent", func() error {
			b := &applier{newTask: map[string]uuid.UUID{}}
			_, _, err := b.createParent(Change{Key: key}, createValue{Parent: ptrTo("new:99")})
			return err
		}},
		{"deliverable", func() error {
			b := &applier{newMile: map[string]uuid.UUID{},
				pendingGates: []pendingGate{{task: uuid.New(), key: key, gate: "new-milestone:9"}}}
			return b.linkPendingGates()
		}},
	}
	for _, tc := range cases {
		err := tc.call()
		rej := exRejection(t, err)
		if rej.status != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s, want 422", tc.name, rej.status, rej.code)
		}
		if !slices.Equal(rej.fields, []string{key}) {
			t.Errorf("%s: fields = %v, want the ticked key named", tc.name, rej.fields)
		}
	}
}

// TestApply_RefusedPlacementNamesTheCreate: the position pass writes a ticked move AND
// the position of a task the file added, but only the latter was ever on the review
// list: a create row has no move row of its own, so a placement refused on a created
// row must name `new:<file id>` (what the manager ticked) and never `new:<file id>:move`
// (a key the preview never offered, which the wizard would highlight nothing for).
//
// A decoded file cannot reach a refused placement on its own row: the create writes the
// file's parent, so the position pass writes the same one and the rules see no change.
// The two new rows are therefore hung under each other after the creates ran — a loop no
// file can ask for (its create is refused before a single write), which is what a hand
// built request looks like. The refusal is the shared rule's own.
func TestApply_RefusedPlacementNamesTheCreate(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	file := e.basic
	file.Tasks = append(slices.Clone(e.basic.Tasks),
		dfxNew("7", "", "Safety inspection", dfxMon, 1),
		dfxNew("8", "new:7", "Punch list", dfxMon, 1))

	var placeErr error
	rollback := errors.New("roll the batch back")
	ctx := ctxFor(f.caller(e.mgr))
	// Read before the transaction, as the apply route does: a second connection reading
	// `users` while this transaction holds its lock waits forever behind any DDL another
	// test package queues on that table in the meantime (CI runs packages in parallel).
	users := exUsers(t, f)
	txErr := orm.Transact(ctx, f.app.DB, func(tx *orm.Tx) error {
		cur, err := loadPlan(ctx, tx, f.tenant, pid, file.Weekend)
		if err != nil {
			return err
		}
		a, err := newApplier(f.handler(), ctx, tx, f.tenant, pid, cur, file, users, []string{"new:7", "new:8"})
		if err != nil {
			return err
		}
		if err := a.createTasks(); err != nil {
			return err
		}
		for i := range a.d.file.Tasks {
			if a.d.file.Tasks[i].Name == "Safety inspection" {
				a.d.file.Tasks[i].Parent = "new:8" // under the row that hangs under it
			}
		}
		placeErr = a.placeTasks()
		return rollback
	})
	if !errors.Is(txErr, rollback) {
		t.Fatalf("transaction: %v, want it rolled back", txErr)
	}
	rej := exRejection(t, placeErr)
	if rej.status != http.StatusUnprocessableEntity {
		t.Fatalf("a create placed under its own child: %d %s, want 422", rej.status, rej.code)
	}
	if !slices.Equal(rej.fields, []string{"new:7"}) {
		t.Errorf("fields = %v, want [new:7] (the create the manager ticked, not a move row the preview never offered)", rej.fields)
	}
	if !strings.Contains(rej.msg, "parent") {
		t.Errorf("message %q, want the task rule's own words about a parent", rej.msg)
	}
}

// TestApply_RemovalDepths: the removal pass sorts the doomed tasks deepest first, on a
// depth counted ONCE over the plan. Counted per comparison instead, one batch at the
// 5000-task ceiling rebuilt the parent map some 6·10^8 times inside the transaction that
// holds the project row FOR UPDATE.
func TestApply_RemovalDepths(t *testing.T) {
	kA, kB, kC := dfxKey(dfxA), dfxKey(dfxB), dfxKey(dfxC)
	a := &applier{d: &diff{cur: dfxPlan([]PlanTask{
		dfxTask(kA, "", "Design", dfxMon, 1),
		dfxTask(kB, kA, "Build", dfxTue, 1),
		dfxTask(kC, kB, "Review", dfxWed, 1),
		dfxTask(dfxKey(dfxDrop), kC, "Handover", dfxThu, 1),
	}, nil)}}
	got := a.depths()
	if got[kA] != 0 || got[kB] != 1 || got[kC] != 2 || got[dfxKey(dfxDrop)] != 3 {
		t.Errorf("depths = %v, want %s 0, %s 1, %s 2, %s 3", got, kA, kB, kC, dfxKey(dfxDrop))
	}
	if got["nope"] != 0 {
		t.Errorf("depth of a key the plan does not hold = %d, want 0 (the sort still orders it, last)", got["nope"])
	}
}

// exChains is a plan of chains trees, each depth rows deep, every row a fresh EERP
// identity: the shape the removal pass is written for, where a doomed parent always
// comes with its whole subtree.
func exChains(chains, depth int) Plan {
	p := Plan{Weekend: DefaultWeekend}
	for c := 0; c < chains; c++ {
		var parent string
		for d := 0; d < depth; d++ {
			ref := uuid.NewString()
			p.Tasks = append(p.Tasks, PlanTask{Ref: ref, Parent: parent, Name: "Bulk row",
				Start: day(dfxDay(dfxMon)), Duration: 1})
			parent = ref
		}
	}
	return p
}

// TestApply_BulkRemovalOfADeepTree: a partner clearing a whole branch is the ordinary
// case the removal order exists for, at a size no hand written test row reaches. Three
// hundred tasks in ten trees thirty deep go in one batch, and the pass that sorts them
// deepest first runs for real (at the 5000-task ceiling that sort is the difference
// between a batch and a project row locked for a minute).
func TestApply_BulkRemovalOfADeepTree(t *testing.T) {
	e := exFixture(t)
	f, pid := e.f, e.pid
	const chains, depth = 10, 30
	exReinstall(t, f, pid, exChains(chains, depth))

	emptied := Plan{Weekend: DefaultWeekend}
	_, changes, _ := exPreview(t, f, pid, emptied)
	if got := dfxCount(changes, kindDelete); got != chains*depth {
		t.Fatalf("%d removal rows, want %d", got, chains*depth)
	}
	n := exApply(t, f, f.caller(e.mgr), pid, emptied, "cleared.gan", exKeysOf(changes)...)
	if n != chains*depth {
		t.Errorf("applied %d rows, want %d", n, chains*depth)
	}
	var live int
	if err := f.app.DB.QueryRow(context.Background(), `SELECT count(*) FROM project_task
		WHERE tenant_id = $1 AND project_id = $2 AND deleted_at IS NULL`, f.tenant, pid).Scan(&live); err != nil {
		t.Fatalf("count the live tasks: %v", err)
	}
	if live != 0 {
		t.Errorf("%d tasks still live, want the whole tree gone", live)
	}
}
