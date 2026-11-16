package project

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDelaySeverity(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want int
	}{{0, 1}, {6.9, 2}, {7, 3}, {14, 3}, {14.1, 4}} {
		if got := delaySeverity(c.in); got != c.want {
			t.Errorf("delaySeverity(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestCostSeverity(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want int
	}{{0, 1}, {4.9, 2}, {5, 3}, {10, 3}, {10.1, 4}} {
		if got := costSeverity(c.in); got != c.want {
			t.Errorf("costSeverity(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestProjectFinish_Fixture(t *testing.T) {
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
}

func TestRiskSeverity(t *testing.T) {
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	// a(1d) -> b(10d) is critical (11d); c(1d) is parallel with 10d of slack.
	tasks := []calcTask{{ID: a, PlannedHours: 8}, {ID: b, PlannedHours: 80}, {ID: c, PlannedHours: 8}}
	links := []calcLink{{From: a, To: b}}
	f := func(v float64) *float64 { return &v }
	rt := func(id uuid.UUID, d, h *float64) []ProjectRiskTask {
		return []ProjectRiskTask{{TaskID: id, DelayDays: d, ExtraHours: h}}
	}
	closed := []calcTask{{ID: a, PlannedHours: 8}, {ID: b, PlannedHours: 80, Closed: true}}
	cyc := []calcLink{{From: a, To: b}, {From: b, To: a}}

	for _, tc := range []struct {
		name   string
		impact string
		tasks  []calcTask
		links  []calcLink
		hours  float64
		risk   []ProjectRiskTask
		want   int
		note   string
	}{
		{"critical delay", "delay", tasks, links, 0, rt(b, f(8), nil), 3, ""},
		{"slack absorbs delay", "delay", tasks, links, 0, rt(c, f(8), nil), 1, ""},
		{"closed task", "delay", closed, links, 0, rt(b, f(8), nil), 1, ""},
		{"cycle", "delay", tasks, cyc, 0, rt(b, f(8), nil), 0, "cycle"},
		{"cost no hours", "cost", tasks, links, 0, rt(b, nil, f(5)), 0, "no_planned_hours"},
		{"cost", "cost", tasks, links, 100, rt(b, nil, f(7)), 3, ""},
		{"delay no estimate", "delay", tasks, links, 0, rt(b, nil, f(5)), 0, "no_estimate"},
		{"quality", "quality", tasks, links, 0, rt(b, f(8), nil), 0, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sev, note := riskSeverity(tc.impact, tc.tasks, tc.links, tc.hours, tc.risk)
			if note != tc.note {
				t.Fatalf("note = %q, want %q", note, tc.note)
			}
			if tc.want == 0 {
				if sev != nil {
					t.Fatalf("sev = %d, want nil", *sev)
				}
			} else if sev == nil || *sev != tc.want {
				t.Fatalf("sev = %v, want %d", sev, tc.want)
			}
		})
	}
}
