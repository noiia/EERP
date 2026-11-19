package project

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"testing"
	"time"

	"core/internal/auth"

	"github.com/google/uuid"
)

func TestSchedule_CriticalChain(t *testing.T) {
	// A -> B -> D runs 1 + 2 + 2 days, A -> C -> D runs 1 + 1 + 2: the first
	// chain is the longest path, so A, B and D are critical and C's slack is
	// the 1-day difference.
	a, b, c, d := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	tasks := []calcTask{{ID: a, PlannedHours: 8}, {ID: b, PlannedHours: 16}, {ID: c, PlannedHours: 8}, {ID: d, PlannedHours: 16}}
	links := []calcLink{{a, b}, {a, c}, {b, d}, {c, d}}

	rows, finish, ok := schedule(tasks, links)
	if !ok {
		t.Fatal("ok=false on a cycle-free graph")
	}
	if math.Abs(finish-5) > 1e-9 {
		t.Fatalf("finish = %v, want 5", finish)
	}
	byID := map[uuid.UUID]scheduleRow{}
	for _, r := range rows {
		byID[r.ID] = r
	}
	if len(byID) != 4 {
		t.Fatalf("rows = %d, want 4", len(byID))
	}
	want := map[uuid.UUID]struct {
		es, ef, ls, lf, slack float64
		critical              bool
	}{
		a: {0, 1, 0, 1, 0, true},
		b: {1, 3, 1, 3, 0, true},
		c: {1, 2, 2, 3, 1, false},
		d: {3, 5, 3, 5, 0, true},
	}
	for id, w := range want {
		r, found := byID[id]
		if !found {
			t.Fatalf("row %s missing", id)
		}
		got := []float64{r.EarlyStart, r.EarlyFinish, r.LateStart, r.LateFinish, r.Slack}
		want := []float64{w.es, w.ef, w.ls, w.lf, w.slack}
		for i, name := range []string{"early_start", "early_finish", "late_start", "late_finish", "slack"} {
			if math.Abs(got[i]-want[i]) > 1e-9 {
				t.Errorf("task %s: %s = %v, want %v", id, name, got[i], want[i])
			}
		}
		if r.Critical != w.critical {
			t.Errorf("task %s: critical = %v, want %v", id, r.Critical, w.critical)
		}
	}
}

func TestSchedule_Cycle(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	tasks := []calcTask{{ID: a, PlannedHours: 8}, {ID: b, PlannedHours: 8}}
	links := []calcLink{{a, b}, {b, a}}
	rows, finish, ok := schedule(tasks, links)
	if ok {
		t.Fatal("ok=true on a cycle")
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %d, want none", len(rows))
	}
	if finish != 0 {
		t.Fatalf("finish = %v, want 0", finish)
	}

	// The endpoint answers cycle: true with an empty task list.
	f := newFixture(t)
	m := f.caller(uuid.New())
	p := f.project(m.UserID, "everyone")
	t1, t2 := f.task(p, nil, nil), f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET planned_hours = 8 WHERE id = ANY($1)`, []uuid.UUID{t1, t2})
	f.dependency(p, t1, t2)
	f.dependency(p, t2, t1)
	code, body := f.get(m, "project/"+p.String()+"/schedule")
	if code != http.StatusOK {
		t.Fatalf("schedule: %d %v, want 200", code, body)
	}
	if body["cycle"] != true {
		t.Errorf("cycle = %v, want true", body["cycle"])
	}
	if list, _ := body["tasks"].([]any); list == nil || len(list) != 0 {
		t.Errorf("tasks = %v, want []", body["tasks"])
	}
}

func TestSchedule_Visibility(t *testing.T) {
	f := newFixture(t)
	manager, member, outsider, assignee := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	p := f.project(manager, "members")
	f.member(p, member)
	t1 := f.task(p, nil, nil)
	f.exec(`UPDATE project SET date_start = '2026-01-05' WHERE id = $1`, p)
	f.exec(`UPDATE project_task SET planned_hours = 16 WHERE id = $1`, t1)
	f.assign(p, t1, assignee) // sees the task only: still no project

	path := "project/" + p.String() + "/schedule"
	for name, who := range map[string]auth.Identity{
		"outsider":      f.caller(outsider),
		"task assignee": f.caller(assignee),
	} {
		t.Run(name+" gets 404", func(t *testing.T) {
			if code, body := f.get(who, path); code != http.StatusNotFound {
				t.Errorf("schedule: %d %v, want 404", code, body)
			}
		})
	}
	for name, who := range map[string]auth.Identity{
		"manager": f.caller(manager),
		"member":  f.caller(member),
		"admin":   f.caller(uuid.New(), AdminGroup),
	} {
		t.Run(name+" sees the schedule", func(t *testing.T) {
			code, body := f.get(who, path)
			if code != http.StatusOK {
				t.Fatalf("schedule: %d %v, want 200", code, body)
			}
			if body["start"] != "2026-01-05" {
				t.Errorf("start = %v, want 2026-01-05", body["start"])
			}
			if body["cycle"] != false {
				t.Errorf("cycle = %v, want false", body["cycle"])
			}
			if body["finish_days"] != float64(2) { // 16h at 8h per day
				t.Errorf("finish_days = %v, want 2", body["finish_days"])
			}
			tasks, _ := body["tasks"].([]any)
			if len(tasks) != 1 || tasks[0].(map[string]any)["id"] != t1.String() {
				t.Errorf("tasks = %v, want the one task", body["tasks"])
			}
		})
	}
	t.Run("start falls back to the earliest task, then to today", func(t *testing.T) {
		other := f.project(manager, "everyone")
		t2 := f.task(other, nil, nil)
		f.exec(`UPDATE project_task SET date_start = '2026-02-01', planned_hours = 8 WHERE id = $1`, t2)
		code, body := f.get(f.caller(manager), "project/"+other.String()+"/schedule")
		if code != http.StatusOK || body["start"] != "2026-02-01" {
			t.Fatalf("no project date: %d %v, want start 2026-02-01", code, body)
		}
		nodate := f.project(manager, "everyone")
		f.task(nodate, nil, nil)
		code, body = f.get(f.caller(manager), "project/"+nodate.String()+"/schedule")
		if code != http.StatusOK || body["start"] != time.Now().UTC().Format("2006-01-02") {
			t.Fatalf("no dates at all: %d %v, want today", code, body)
		}
		if body["finish_days"] != float64(1) { // a dateless task counts 1 day
			t.Errorf("finish_days = %v, want 1", body["finish_days"])
		}
	})
}

func TestRiskCalc_UnchangedByRefactor(t *testing.T) {
	// The forward pass moved to schedule.go: the fixture still pins
	// projectFinish, and riskSeverity's delay path still derives the severity
	// from the finish delta.
	raw, err := os.ReadFile("testdata/risk_pert_fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Tasks []struct {
			ID           string     `json:"id"`
			PlannedHours *float64   `json:"plannedHours"`
			DateStart    *time.Time `json:"dateStart"`
			Deadline     *time.Time `json:"deadline"`
		} `json:"tasks"`
		Links  []struct{ From, To string } `json:"links"`
		Finish float64                     `json:"finish"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	ids := map[string]uuid.UUID{}
	var tasks []calcTask
	for _, x := range fx.Tasks {
		id := uuid.New()
		ids[x.ID] = id
		ct := calcTask{ID: id, DateStart: x.DateStart, Deadline: x.Deadline}
		if x.PlannedHours != nil {
			ct.PlannedHours = *x.PlannedHours
		}
		tasks = append(tasks, ct)
	}
	var links []calcLink
	for _, l := range fx.Links {
		links = append(links, calcLink{From: ids[l.From], To: ids[l.To]})
	}
	got, ok := projectFinish(tasks, links, nil)
	if !ok || math.Abs(got-fx.Finish) > 1e-6 {
		t.Fatalf("projectFinish = %v (ok=%v), want %v", got, ok, fx.Finish)
	}

	a, b := uuid.New(), uuid.New()
	ts := []calcTask{{ID: a, PlannedHours: 8}, {ID: b, PlannedHours: 80}} // 1 + 10 days
	ls := []calcLink{{a, b}}
	slip := 8.0
	sev, note := riskSeverity("delay", ts, ls, 0, []ProjectRiskTask{{TaskID: b, DelayDays: &slip}})
	if note != "" || sev == nil || *sev != 3 {
		t.Fatalf("riskSeverity = %v (note %q), want 3 ''", sev, note)
	}
}
