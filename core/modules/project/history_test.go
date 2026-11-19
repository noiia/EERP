package project

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// history_test.go covers WP1's trigger-maintained history: the task's
// closed_at, the project_task_stage intervals and the project_risk_history
// daily rows (migrate.go, ADR-041).

func (f *fixture) closedAt(task uuid.UUID) *time.Time {
	f.t.Helper()
	var v *time.Time
	if err := f.app.DB.QueryRow(context.Background(), `SELECT closed_at FROM project_task WHERE id = $1`, task).Scan(&v); err != nil {
		f.t.Fatalf("closed_at: %v", err)
	}
	return v
}

type stageSpan struct {
	stageID   uuid.UUID
	projectID uuid.UUID
	entered   time.Time
	left      *time.Time
}

func (f *fixture) stageSpans(task uuid.UUID) []stageSpan {
	f.t.Helper()
	rows, err := f.app.DB.Query(context.Background(),
		`SELECT stage_id, project_id, entered_at, left_at FROM project_task_stage WHERE task_id = $1 ORDER BY entered_at`, task)
	if err != nil {
		f.t.Fatalf("stage history: %v", err)
	}
	defer rows.Close()
	var out []stageSpan
	for rows.Next() {
		var s stageSpan
		if err := rows.Scan(&s.stageID, &s.projectID, &s.entered, &s.left); err != nil {
			f.t.Fatalf("stage history row: %v", err)
		}
		out = append(out, s)
	}
	return out
}

// openStageSpan is the task's still-open history row (left_at NULL), or nil.
func (f *fixture) openStageSpan(task uuid.UUID) *stageSpan {
	f.t.Helper()
	spans := f.stageSpans(task)
	open := 0
	var last *stageSpan
	for i := range spans {
		if spans[i].left == nil {
			open++
			last = &spans[i]
		}
	}
	if open > 1 {
		f.t.Fatalf("task %s: %d open history rows, want at most 1", task, open)
	}
	return last
}

func (f *fixture) migrateProject() {
	f.t.Helper()
	if err := (&projectModule{}).Migrate(context.Background(), f.app.DB); err != nil {
		f.t.Fatalf("migrate: %v", err)
	}
}

// TestClosedAt_SetWhenStageCloses: moving a task to a closed stage sets
// closed_at ≈ now(); moving it back to an open stage clears it.
func TestClosedAt_SetWhenStageCloses(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	task := f.task(p, nil, nil)
	if got := f.closedAt(task); got != nil {
		t.Fatalf("open task: closed_at %v, want NULL", *got)
	}
	f.moveTo(task, f.stage(p, "Done"))
	got := f.closedAt(task)
	if got == nil {
		t.Fatal("moved into a closed stage: closed_at NULL, want ≈ now()")
	}
	if !got.Before(time.Now().Add(time.Minute)) {
		t.Errorf("closed_at %v is not ≈ now()", *got)
	}
	f.moveTo(task, f.stage(p, "New"))
	if got := f.closedAt(task); got != nil {
		t.Fatalf("moved back to an open stage: closed_at %v, want NULL", *got)
	}
}

// TestClosedAt_Backfill: a task closed before the migration gets a closed_at
// (and its updated_at bumped) after Migrate; a second Migrate changes nothing.
func TestClosedAt_Backfill(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	task := f.task(p, nil, nil)
	updated := func() time.Time {
		f.t.Helper()
		var v time.Time
		if err := f.app.DB.QueryRow(context.Background(), `SELECT updated_at FROM project_task WHERE id = $1`, task).Scan(&v); err != nil {
			f.t.Fatalf("updated_at: %v", err)
		}
		return v
	}
	before := updated()
	// A task closed before the feature existed: closed, but no closed_at.
	f.exec(`UPDATE project_task SET closed = true, closed_at = NULL WHERE id = $1`, task)
	f.migrateProject()
	first := f.closedAt(task)
	if first == nil {
		t.Fatal("backfill: closed_at still NULL, want set")
	}
	afterFirst := updated()
	if !afterFirst.After(before) {
		t.Fatalf("backfill: updated_at %v not after %v", afterFirst, before)
	}
	f.migrateProject()
	if got := f.closedAt(task); got == nil || !got.Equal(*first) {
		t.Fatalf("second migrate changed closed_at: %v -> %v", *first, got)
	}
	if got := updated(); !got.Equal(afterFirst) {
		t.Fatalf("second migrate changed updated_at: %v -> %v", afterFirst, got)
	}
}

// TestStageHistory_TracksMoves: the insert leaves one open row; a stage
// change closes it and opens a new one; a project move opens a row in the
// new project; a soft delete closes the open row.
func TestStageHistory_TracksMoves(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	newStage, inProgress := f.stage(p, "New"), f.stage(p, "In progress")
	task := f.task(p, nil, nil)
	span := f.openStageSpan(task)
	if span == nil || len(f.stageSpans(task)) != 1 || span.stageID != newStage || span.projectID != p {
		t.Fatalf("after insert: %v, want one open row in the task's stage and project", f.stageSpans(task))
	}
	// Stage change: the previous row gets left_at, a new open row appears.
	f.moveTo(task, inProgress)
	if span := f.openStageSpan(task); span == nil || span.stageID != inProgress {
		t.Fatalf("after stage change: open row %v, want the new stage open", span)
	}
	for _, s := range f.stageSpans(task) {
		if s.stageID == newStage && s.left == nil {
			t.Fatalf("after stage change: the previous row is still open: %v", f.stageSpans(task))
		}
	}
	// Project move: a new open row with the new project_id.
	p2 := f.project(uuid.New(), "everyone")
	f.exec(`UPDATE project_task SET project_id = $2 WHERE id = $1`, task, p2)
	if span := f.openStageSpan(task); span == nil || span.projectID != p2 {
		t.Fatalf("after project move: open row %v, want a row in the new project", span)
	}
	for _, s := range f.stageSpans(task) {
		if s.projectID == p && s.left == nil {
			t.Fatalf("after project move: a row of the old project is still open: %v", f.stageSpans(task))
		}
	}
	// Soft delete: the open row closes, no new row.
	f.exec(`UPDATE project_task SET deleted_at = now() WHERE id = $1`, task)
	if span := f.openStageSpan(task); span != nil {
		t.Fatalf("after soft delete: a row is still open: %v", f.stageSpans(task))
	}
	if n := len(f.stageSpans(task)); n != 3 {
		t.Fatalf("after soft delete: %d rows, want 3 (none open)", n)
	}
}

// TestStageHistory_Backfill: a task without history gets one open row
// entered_at = created_at after Migrate; a second Migrate changes nothing.
func TestStageHistory_Backfill(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	task := f.task(p, nil, nil)
	var created time.Time
	if err := f.app.DB.QueryRow(context.Background(), `SELECT created_at FROM project_task WHERE id = $1`, task).Scan(&created); err != nil {
		t.Fatal(err)
	}
	// A task that predates the feature: no history at all.
	f.exec(`DELETE FROM project_task_stage WHERE task_id = $1`, task)
	f.migrateProject()
	spans := f.stageSpans(task)
	if len(spans) != 1 || spans[0].left != nil || spans[0].stageID != f.stage(p, "New") || !spans[0].entered.Equal(created) {
		t.Fatalf("backfill: %v, want one open row entered at created_at", spans)
	}
	f.migrateProject()
	spans = f.stageSpans(task)
	if len(spans) != 1 || spans[0].left != nil || !spans[0].entered.Equal(created) {
		t.Fatalf("second migrate: %v, want the same single row (idempotent)", spans)
	}
}

// TestRiskHistory_DailyUpsert: two criticity changes on the same day upsert
// the single (risk_id, recorded_on) row to the last value; a soft delete
// marks today's row deleted.
func TestRiskHistory_DailyUpsert(t *testing.T) {
	f := newFixture(t)
	p := f.project(uuid.New(), "everyone")
	risk := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'R', 'delay', 1, 1, 1) RETURNING id`, f.tenant, p)
	// Two criticity changes on the same day: one row holding the last value.
	f.exec(`UPDATE project_risk SET likelihood = 2 WHERE id = $1`, risk)
	f.exec(`UPDATE project_risk SET likelihood = 3 WHERE id = $1`, risk)
	var n, criticity int
	if err := f.app.DB.QueryRow(context.Background(),
		`SELECT count(*), coalesce(max(criticity), -1) FROM project_risk_history WHERE risk_id = $1 AND recorded_on = CURRENT_DATE`, risk).
		Scan(&n, &criticity); err != nil {
		t.Fatal(err)
	}
	if n != 1 || criticity != 3 {
		t.Fatalf("history: %d rows, criticity %d, want 1 row holding the last criticity (3)", n, criticity)
	}
	// A soft delete marks today's row deleted.
	f.exec(`UPDATE project_risk SET deleted_at = now() WHERE id = $1`, risk)
	var deleted bool
	if err := f.app.DB.QueryRow(context.Background(),
		`SELECT deleted FROM project_risk_history WHERE risk_id = $1 AND recorded_on = CURRENT_DATE`, risk).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	if !deleted {
		t.Fatal("soft delete: today's row is not marked deleted")
	}
}
