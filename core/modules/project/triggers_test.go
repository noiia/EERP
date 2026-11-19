package project

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func (f *fixture) float(sql string, args ...any) float64 {
	f.t.Helper()
	var v float64
	if err := f.app.DB.QueryRow(context.Background(), `SELECT (`+sql+`)::float8`, args...).Scan(&v); err != nil {
		f.t.Fatalf("query %q: %v", sql, err)
	}
	return v
}

func (f *fixture) blocked(task uuid.UUID) bool {
	f.t.Helper()
	var b bool
	if err := f.app.DB.QueryRow(context.Background(), `SELECT blocked FROM project_task WHERE id = $1`, task).Scan(&b); err != nil {
		f.t.Fatalf("blocked: %v", err)
	}
	return b
}

func (f *fixture) moveTo(task, stage uuid.UUID) {
	f.exec(`UPDATE project_task SET stage_id = $2 WHERE id = $1`, task, stage)
}

func TestTriggers_DefaultStages(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	rows, err := f.app.DB.Query(context.Background(),
		`SELECT name, sequence, closed FROM project_stage WHERE project_id = $1 ORDER BY sequence`, p)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type stage struct {
		name   string
		seq    int
		closed bool
	}
	var got []stage
	for rows.Next() {
		var s stage
		if err := rows.Scan(&s.name, &s.seq, &s.closed); err != nil {
			t.Fatal(err)
		}
		got = append(got, s)
	}
	want := []stage{{"New", 10, false}, {"In progress", 20, false}, {"Done", 30, true}}
	if len(got) != len(want) {
		t.Fatalf("stages %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("stage %d: %v, want %v", i, got[i], want[i])
		}
	}
}

func TestTriggers_SpentAndSubtaskHours(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	task := f.task(p, nil, nil)
	sub := f.task(p, &task, nil)
	f.timesheet(p, task, 2)
	f.timesheet(p, task, 3)
	f.timesheet(p, sub, 1)
	f.exec(`UPDATE project_task SET planned_hours = 4 WHERE id = $1`, task)

	checks := map[string]float64{
		`SELECT spent_hours FROM project_task WHERE id = $1`:   5,
		`SELECT subtask_hours FROM project_task WHERE id = $1`: 1,
		`SELECT subtask_count FROM project_task WHERE id = $1`: 1,
	}
	for q, want := range checks {
		if got := f.float(q, task); got != want {
			t.Errorf("%s: %v, want %v", q, got, want)
		}
	}
	for q, want := range map[string]float64{
		`SELECT spent_hours FROM project WHERE id = $1`:   6,
		`SELECT planned_hours FROM project WHERE id = $1`: 4,
		`SELECT task_count FROM project WHERE id = $1`:    2,
	} {
		if got := f.float(q, p); got != want {
			t.Errorf("%s: %v, want %v", q, got, want)
		}
	}
	// A grandchild's hours roll up through its parent.
	grand := f.task(p, &sub, nil)
	f.timesheet(p, grand, 4)
	if got := f.float(`SELECT subtask_hours FROM project_task WHERE id = $1`, task); got != 5 {
		t.Errorf("subtask_hours with a grandchild: %v, want 5", got)
	}
}

func TestTriggers_SoftDeleteExcludedFromAggregates(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	task := f.task(p, nil, nil)
	sub := f.task(p, &task, nil)
	f.timesheet(p, task, 2)
	ts := f.timesheet(p, task, 3)
	f.timesheet(p, sub, 1)

	f.exec(`UPDATE project_timesheet SET deleted_at = now() WHERE id = $1`, ts)
	if got := f.float(`SELECT spent_hours FROM project_task WHERE id = $1`, task); got != 2 {
		t.Errorf("task spent after soft delete: %v, want 2", got)
	}
	if got := f.float(`SELECT spent_hours FROM project WHERE id = $1`, p); got != 3 {
		t.Errorf("project spent after soft delete: %v, want 3", got)
	}

	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, sub)
	if got := f.float(`SELECT subtask_hours FROM project_task WHERE id = $1`, task); got != 0 {
		t.Errorf("subtask_hours after subtask soft delete: %v, want 0", got)
	}
	if got := f.float(`SELECT subtask_count FROM project_task WHERE id = $1`, task); got != 0 {
		t.Errorf("subtask_count after subtask soft delete: %v, want 0", got)
	}
	if got := f.float(`SELECT task_count FROM project WHERE id = $1`, p); got != 1 {
		t.Errorf("project task_count after soft delete: %v, want 1", got)
	}
	// The deleted subtask's own timesheet no longer counts for the project.
	if got := f.float(`SELECT spent_hours FROM project WHERE id = $1`, p); got != 2 {
		t.Errorf("project spent after subtask soft delete: %v, want 2", got)
	}
}

// The OLD side of each trigger: the row a value moved away from is recounted.
func TestTriggers_OldSideRecount(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	a, b := f.task(p, nil, nil), f.task(p, nil, nil)
	sub := f.task(p, &a, nil)
	ts := f.timesheet(p, sub, 2)

	f.exec(`UPDATE project_task SET parent_id = $2 WHERE id = $1`, sub, b)
	for task, want := range map[uuid.UUID]float64{a: 0, b: 1} {
		if got := f.float(`SELECT subtask_count FROM project_task WHERE id = $1`, task); got != want {
			t.Errorf("re-parent: subtask_count %v, want %v", got, want)
		}
	}
	if got := f.float(`SELECT subtask_hours FROM project_task WHERE id = $1`, a); got != 0 {
		t.Errorf("re-parent: old parent subtask_hours %v, want 0", got)
	}

	f.exec(`UPDATE project_timesheet SET task_id = $2 WHERE id = $1`, ts, a)
	for task, want := range map[uuid.UUID]float64{sub: 0, a: 2} {
		if got := f.float(`SELECT spent_hours FROM project_task WHERE id = $1`, task); got != want {
			t.Errorf("timesheet moved: spent %v, want %v", got, want)
		}
	}

	m := f.milestone(p)
	f.exec(`UPDATE project_task SET milestone_id = $2 WHERE id = $1`, b, m)
	done := f.stage(p, "Done")
	f.moveTo(b, done)
	f.exec(`UPDATE project_stage SET closed = false WHERE id = $1`, done)
	if got := f.float(`SELECT task_done_count FROM project_milestone WHERE id = $1`, m); got != 0 {
		t.Errorf("stage reopened: task_done_count %v, want 0", got)
	}
}

// A parent cycle written behind the validation fails instead of storing
// stale totals.
func TestTriggers_ParentCycleFails(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	a := f.task(p, nil, nil)
	b := f.task(p, &a, nil)
	f.timesheet(p, b, 1)
	if _, err := f.app.DB.Exec(context.Background(), `UPDATE project_task SET parent_id = $2 WHERE id = $1`, a, b); err == nil {
		t.Fatal("a parent cycle was stored")
	}
}

func TestTriggers_Blocked(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	a, b := f.task(p, nil, nil), f.task(p, nil, nil)
	f.dependency(p, b, a)
	if !f.blocked(b) {
		t.Fatal("B depends on an open A: want blocked")
	}
	done := f.stage(p, "Done")
	f.moveTo(a, done)
	if f.blocked(b) {
		t.Error("A done: want unblocked")
	}
	f.moveTo(a, f.stage(p, "In progress"))
	if !f.blocked(b) {
		t.Error("A reopened: want blocked")
	}
	f.moveTo(a, done)
	f.exec(`UPDATE project_stage SET closed = false WHERE id = $1`, done)
	if !f.blocked(b) {
		t.Error("Done no longer closed: want blocked")
	}
	f.exec(`UPDATE project_stage SET closed = true WHERE id = $1`, done)
	if f.blocked(b) {
		t.Error("Done closed again: want unblocked")
	}
}

func TestTriggers_BlockedClearsOnBlockerDelete(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	for name, unblock := range map[string]func(a, dep uuid.UUID){
		"blocker soft-deleted": func(a, _ uuid.UUID) { f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, a) },
		"dependency deleted":   func(_, dep uuid.UUID) { f.exec(`DELETE FROM project_task_dependency WHERE id = $1`, dep) },
		"dependency soft-deleted": func(_, dep uuid.UUID) {
			f.exec(`UPDATE project_task_dependency SET deleted_at = now() WHERE id = $1`, dep)
		},
	} {
		t.Run(name, func(t *testing.T) {
			a, b := f.task(p, nil, nil), f.task(p, nil, nil)
			dep := f.dependency(p, b, a)
			if !f.blocked(b) {
				t.Fatal("want blocked")
			}
			unblock(a, dep)
			if f.blocked(b) {
				t.Error("want unblocked")
			}
		})
	}
}

func TestTriggers_MilestoneCounts(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	m := f.milestone(p)
	t1 := f.task(p, nil, &m)
	f.task(p, nil, &m)
	f.task(p, nil, &m)
	f.moveTo(t1, f.stage(p, "Done"))
	if got := f.float(`SELECT task_count FROM project_milestone WHERE id = $1`, m); got != 3 {
		t.Errorf("task_count %v, want 3", got)
	}
	if got := f.float(`SELECT task_done_count FROM project_milestone WHERE id = $1`, m); got != 1 {
		t.Errorf("task_done_count %v, want 1", got)
	}
	// Moving a task off the milestone recounts it.
	f.exec(`UPDATE project_task SET milestone_id = NULL WHERE id = $1`, t1)
	if got := f.float(`SELECT task_done_count FROM project_milestone WHERE id = $1`, m); got != 0 {
		t.Errorf("task_done_count after unlink %v, want 0", got)
	}
}
