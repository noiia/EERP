package project

import (
	"context"
	"net/http"
	"testing"
	"time"

	"core/internal/auth"

	"github.com/google/uuid"
)

// metrics_test.go covers the GET /api/v1/project/:id/metrics endpoint
// (metrics.go, ADR-041): the burndown scope/done, the earned-value
// pv/ev/ac and spi/cpi, the bucket/window rules, the per-stage flow and
// the risk trend, and the visibility rule (an assignee sees the task,
// not the project's numbers).

const metricsDay = "2006-01-02"

// dbDay is the database's own today (session timezone, Etc/UTC): every
// fixture date is derived from it, so a test never depends on the
// machine's clock.
func (f *fixture) dbDay() string {
	f.t.Helper()
	var s string
	if err := f.app.DB.QueryRow(context.Background(), `SELECT CURRENT_DATE::text`).Scan(&s); err != nil {
		f.t.Fatalf("today: %v", err)
	}
	return s
}

// shift is the date n days away from the database's today (n may be
// negative), formatted YYYY-MM-DD.
func (f *fixture) shift(n int) string {
	f.t.Helper()
	d, err := time.Parse(metricsDay, f.dbDay())
	if err != nil {
		f.t.Fatalf("parse today: %v", err)
	}
	return d.AddDate(0, 0, n).Format(metricsDay)
}

// on is day (YYYY-MM-DD) at noon UTC as a timestamptz literal: the
// database session is Etc/UTC, so the stored instant's date is day.
func (f *fixture) on(day string) string {
	return day + " 12:00:00+00"
}

func (f *fixture) metricsBody(who auth.Identity, project uuid.UUID) map[string]any {
	f.t.Helper()
	code, body := f.get(who, "project/"+project.String()+"/metrics")
	if code != http.StatusOK {
		f.t.Fatalf("GET project metrics: %d %v", code, body)
	}
	return body
}

func (f *fixture) metricsPoints(m map[string]any) []map[string]any {
	f.t.Helper()
	raw, _ := m["points"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, p := range raw {
		out = append(out, p.(map[string]any))
	}
	return out
}

func (f *fixture) metricsPoint(m map[string]any, day string) map[string]any {
	f.t.Helper()
	for _, p := range f.metricsPoints(m) {
		if p["date"] == day {
			return p
		}
	}
	f.t.Fatalf("no metrics point at %s: %v", day, m["points"])
	return nil
}

func (f *fixture) metricsRiskPoint(m map[string]any, day string) map[string]any {
	f.t.Helper()
	raw, _ := m["risk"].([]any)
	for _, p := range raw {
		r := p.(map[string]any)
		if r["date"] == day {
			return r
		}
	}
	f.t.Fatalf("no risk point at %s", day)
	return nil
}

func metricsFloat(v any) float64 {
	n, _ := v.(float64)
	return n
}

func metricsClose(t *testing.T, label string, got, want float64) {
	t.Helper()
	d := got - want
	if d < 0 {
		d = -d
	}
	if d > 1e-9 {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

// TestMetrics_Burndown: 2 tasks of 8 h each, one closed on day 3 →
// done_hours is 8 from day 3 on, and remaining_hours goes 16 → 8.
func TestMetrics_Burndown(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	p := f.project(u, "everyone")
	from := f.shift(-10)
	f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(from), f.on(f.shift(5)))
	a, b := f.task(p, nil, nil), f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET created_at = $2, planned_hours = 8 WHERE id = $1`, a, f.on(from))
	f.exec(`UPDATE project_task SET created_at = $2, planned_hours = 8 WHERE id = $1`, b, f.on(from))
	day3 := f.shift(-8) // the third day of the window (from is day 1)
	f.exec(`UPDATE project_task SET closed = true, closed_at = $2 WHERE id = $1`, a, f.on(day3))
	f.exec(`UPDATE project_task_stage SET entered_at = $2 WHERE task_id = $1 AND left_at IS NULL`, a, f.on(from))
	f.exec(`UPDATE project_task_stage SET entered_at = $2 WHERE task_id = $1 AND left_at IS NULL`, b, f.on(from))

	m := f.metricsBody(f.caller(u), p)
	if m["from"] != from || m["to"] != f.shift(5) || m["bucket"] != "day" {
		t.Fatalf("window: from %v to %v bucket %v, want %s..%s day", m["from"], m["to"], m["bucket"], from, f.shift(5))
	}
	p1 := f.metricsPoint(m, f.shift(-9)) // day 2
	metricsClose(t, "day 2 scope_hours", metricsFloat(p1["scope_hours"]), 16)
	metricsClose(t, "day 2 done_hours", metricsFloat(p1["done_hours"]), 0)
	metricsClose(t, "day 2 remaining_hours", metricsFloat(p1["remaining_hours"]), 16)
	if p1["scope_tasks"] != float64(2) || p1["done_tasks"] != float64(0) {
		t.Errorf("day 2 task counts: scope %v done %v, want 2/0", p1["scope_tasks"], p1["done_tasks"])
	}
	p2 := f.metricsPoint(m, day3) // day 3
	metricsClose(t, "day 3 done_hours", metricsFloat(p2["done_hours"]), 8)
	metricsClose(t, "day 3 remaining_hours", metricsFloat(p2["remaining_hours"]), 8)
	if p2["done_tasks"] != float64(1) {
		t.Errorf("day 3 done_tasks %v, want 1", p2["done_tasks"])
	}
	plast := f.metricsPoint(m, f.shift(5))
	metricsClose(t, "last day remaining_hours", metricsFloat(plast["remaining_hours"]), 8)
}

// TestMetrics_EarnedValue: a task of 10 h over 10 days, half elapsed →
// pv = 5. Closed → ev = 10. Timesheets of 3 h + 4 h → ac = 7. SPI and CPI
// match the formulas (spi = ev/pv, cpi = ev/ac at today).
func TestMetrics_EarnedValue(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	p := f.project(u, "everyone")
	from := f.shift(-5)
	f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(from), f.on(f.shift(5)))
	task := f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET created_at = $2, date_start = $2, deadline = $3, planned_hours = 10,
		closed = true, closed_at = $4 WHERE id = $1`, task, f.on(from), f.on(f.shift(5)), f.on(f.shift(0)))
	f.timesheet(p, task, 3)
	f.timesheet(p, task, 4)

	m := f.metricsBody(f.caller(u), p)
	p0 := f.metricsPoint(m, f.dbDay())
	metricsClose(t, "pv at half elapsed", metricsFloat(p0["pv"]), 5)
	metricsClose(t, "ev closed", metricsFloat(p0["ev"]), 10)
	metricsClose(t, "ac", metricsFloat(p0["ac"]), 7)
	metricsClose(t, "spi", metricsFloat(m["spi"]), 2)
	metricsClose(t, "cpi", metricsFloat(m["cpi"]), 10.0/7.0)
}

// TestMetrics_NoData: a project with no dates, no planned hours and no
// timesheets answers zeros, spi/cpi null, pv_excluded counting the
// dateless tasks.
func TestMetrics_NoData(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	p := f.project(u, "everyone")
	f.task(p, nil, nil)
	f.task(p, nil, nil)

	m := f.metricsBody(f.caller(u), p)
	today := f.dbDay()
	if m["from"] != today || m["to"] != today || m["bucket"] != "day" {
		t.Fatalf("window: %v..%v %v, want %s..%s day", m["from"], m["to"], m["bucket"], today, today)
	}
	pts := f.metricsPoints(m)
	if len(pts) != 1 {
		t.Fatalf("points: %d, want 1", len(pts))
	}
	for k, want := range map[string]float64{"scope_hours": 0, "done_hours": 0, "remaining_hours": 0, "pv": 0, "ev": 0, "ac": 0} {
		if got := metricsFloat(pts[0][k]); got != want {
			t.Errorf("%s = %v, want %v", k, got, want)
		}
	}
	if m["spi"] != nil || m["cpi"] != nil {
		t.Errorf("spi %v / cpi %v, want null", m["spi"], m["cpi"])
	}
	if m["pv_excluded"] != float64(2) {
		t.Errorf("pv_excluded = %v, want 2", m["pv_excluded"])
	}
	ideal, ok := m["ideal"].([]any)
	if !ok || len(ideal) != 0 {
		t.Errorf("ideal = %v, want [] (no date_end)", m["ideal"])
	}
	if stages, _ := m["stages"].([]any); len(stages) != 3 {
		t.Errorf("stages: %d, want the 3 defaults", len(stages))
	}
}

// TestMetrics_Bucket: ≤ 120 days → day, else week (points on Mondays, the
// last point today). The window is capped at 3 years.
func TestMetrics_Bucket(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	t.Run("span within 120 days is daily", func(t *testing.T) {
		p := f.project(u, "everyone")
		f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(f.shift(-10)), f.on(f.shift(10)))
		m := f.metricsBody(f.caller(u), p)
		if m["bucket"] != "day" {
			t.Fatalf("bucket %v, want day", m["bucket"])
		}
		if n := len(f.metricsPoints(m)); n != 21 {
			t.Fatalf("points: %d, want 21", n)
		}
	})
	t.Run("span beyond 120 days is weekly on Mondays", func(t *testing.T) {
		p := f.project(u, "everyone")
		f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(f.shift(-10)), f.on(f.shift(200)))
		m := f.metricsBody(f.caller(u), p)
		if m["bucket"] != "week" {
			t.Fatalf("bucket %v, want week", m["bucket"])
		}
		pts := f.metricsPoints(m)
		for i, p := range pts {
			d, err := time.Parse(metricsDay, p["date"].(string))
			if err != nil {
				t.Fatal(err)
			}
			if i < len(pts)-1 && d.Weekday() != time.Monday {
				t.Fatalf("point %d (%s) is not a Monday", i, p["date"])
			}
		}
		if pts[len(pts)-1]["date"] != f.dbDay() {
			t.Fatalf("last point %v, want today (%s)", pts[len(pts)-1]["date"], f.dbDay())
		}
	})
	t.Run("window capped at three years", func(t *testing.T) {
		p := f.project(u, "everyone")
		today, _ := time.Parse(metricsDay, f.dbDay())
		f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`,
			p, f.on(f.shift(0)), f.on(today.AddDate(4, 0, 0).Format(metricsDay)))
		m := f.metricsBody(f.caller(u), p)
		if m["to"] != today.AddDate(3, 0, 0).Format(metricsDay) {
			t.Fatalf("to %v, want %s (from + 3 years)", m["to"], today.AddDate(3, 0, 0).Format(metricsDay))
		}
		if m["bucket"] != "week" {
			t.Fatalf("bucket %v, want week", m["bucket"])
		}
	})
}

// TestMetrics_Flow: a task moved between stages counts in the right stage
// per date.
func TestMetrics_Flow(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	p := f.project(u, "everyone")
	from := f.shift(-10)
	f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(from), f.on(f.shift(5)))
	task := f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET created_at = $2, planned_hours = 4 WHERE id = $1`, task, f.on(from))
	inProgress := f.stage(p, "In progress")
	f.exec(`UPDATE project_task SET stage_id = $2 WHERE id = $1`, task, inProgress) // closes the New span, opens In progress
	f.exec(`UPDATE project_task_stage SET entered_at = $2, left_at = $3 WHERE task_id = $1 AND left_at IS NOT NULL`, task, f.on(from), f.on(f.shift(-8)))
	f.exec(`UPDATE project_task_stage SET entered_at = $2 WHERE task_id = $1 AND left_at IS NULL`, task, f.on(f.shift(-8)))

	m := f.metricsBody(f.caller(u), p)
	idOf := map[string]string{}
	raw, _ := m["stages"].([]any)
	for _, s := range raw {
		st := s.(map[string]any)
		idOf[st["name"].(string)] = st["id"].(string)
	}
	newID, inID, doneID := idOf["New"], idOf["In progress"], idOf["Done"]
	flowAt := func(day string) map[string]int {
		raw, _ := m["flow"].([]any)
		for _, row := range raw {
			r := row.(map[string]any)
			if r["date"] == day {
				counts := map[string]int{}
				c, _ := r["counts"].(map[string]any)
				for k, v := range c {
					counts[k] = int(v.(float64))
				}
				return counts
			}
		}
		f.t.Fatalf("no flow point at %s", day)
		return nil
	}
	c1 := flowAt(f.shift(-9)) // still in New
	if c1[newID] != 1 || c1[inID] != 0 || c1[doneID] != 0 {
		t.Fatalf("before the move: %v, want New 1, In progress 0, Done 0", c1)
	}
	c2 := flowAt(f.shift(-7)) // since the move
	if c2[newID] != 0 || c2[inID] != 1 || c2[doneID] != 0 {
		t.Fatalf("after the move: %v, want New 0, In progress 1, Done 0", c2)
	}
}

// TestMetrics_RiskTrend: the per-date risk row uses the last snapshot per
// risk ≤ the date; deleted risks drop out.
func TestMetrics_RiskTrend(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	p := f.project(u, "everyone")
	from := f.shift(-10)
	f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(from), f.on(f.shift(2)))
	const riskSQL = `INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, $3, 'delay', 1, 1, $4) RETURNING id`
	risk1 := f.id(riskSQL, f.tenant, p, "R1", 2) // criticity 2
	f.exec(`UPDATE project_risk_history SET recorded_on = $2 WHERE risk_id = $1 AND recorded_on = CURRENT_DATE`, risk1, f.shift(-5))
	f.exec(`UPDATE project_risk SET likelihood = 2, detectability = 2 WHERE id = $1`, risk1) // criticity 8, today's row
	risk2 := f.id(riskSQL, f.tenant, p, "R2", 4)                                             // criticity 4
	f.exec(`UPDATE project_risk SET deleted_at = now() WHERE id = $1`, risk2)                // marks today's row deleted

	m := f.metricsBody(f.caller(u), p)
	r0 := f.metricsRiskPoint(m, from)
	if r0["max_criticity"] != nil || r0["sum_criticity"] != float64(0) {
		t.Fatalf("before any snapshot: max %v sum %v, want null/0", r0["max_criticity"], r0["sum_criticity"])
	}
	r1 := f.metricsRiskPoint(m, f.shift(-3)) // R1's last snapshot ≤ -3 is the backdated 2; R2 only has today's row
	if r1["max_criticity"] != float64(2) || r1["sum_criticity"] != float64(2) ||
		r1["green"] != float64(1) || r1["amber"] != float64(0) || r1["red"] != float64(0) {
		t.Fatalf("at %s: %v, want max/sum 2 and green 1", f.shift(-3), r1)
	}
	r2 := f.metricsRiskPoint(m, f.dbDay()) // R1 at 8 (amber); R2's deleted row drops out
	if r2["max_criticity"] != float64(8) || r2["sum_criticity"] != float64(8) ||
		r2["amber"] != float64(1) || r2["green"] != float64(0) || r2["red"] != float64(0) {
		t.Fatalf("today: %v, want max/sum 8 and amber 1 (deleted R2 dropped)", r2)
	}
}

// TestMetrics_Visibility: a members-only project read by a non-member, by
// a task assignee, and from another tenant → 404 each; manager, member
// and admin get 200.
func TestMetrics_Visibility(t *testing.T) {
	f := newFixture(t)
	manager, member, assignee, outsider := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	p := f.project(manager, "members")
	f.member(p, member)
	task := f.task(p, nil, nil)
	f.assign(p, task, assignee)

	cases := map[string]struct {
		who  auth.Identity
		want int
	}{
		"manager":        {f.caller(manager), http.StatusOK},
		"member":         {f.caller(member), http.StatusOK},
		"admin":          {f.caller(uuid.New(), AdminGroup), http.StatusOK},
		"non-member":     {f.caller(outsider), http.StatusNotFound},
		"task assignee":  {f.caller(assignee), http.StatusNotFound},
		"another tenant": {auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}, http.StatusNotFound},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			code, _ := f.get(tc.who, "project/"+p.String()+"/metrics")
			if code != tc.want {
				t.Fatalf("status %d, want %d", code, tc.want)
			}
		})
	}
}

// TestMetrics_MovedTask: a task moved out of project A on day 5 is in
// A's scope up to day 4 only.
func TestMetrics_MovedTask(t *testing.T) {
	f := newFixture(t)
	u := uuid.New()
	a, b := f.project(u, "everyone"), f.project(u, "everyone")
	from := f.shift(-10)
	for _, p := range []uuid.UUID{a, b} {
		f.exec(`UPDATE project SET date_start = $2, date_end = $3 WHERE id = $1`, p, f.on(from), f.on(f.shift(5)))
	}
	task := f.task(a, nil, nil)
	f.exec(`UPDATE project_task SET created_at = $2, planned_hours = 4 WHERE id = $1`, task, f.on(from))
	f.exec(`UPDATE project_task_stage SET entered_at = $2 WHERE task_id = $1 AND left_at IS NULL`, task, f.on(from))
	moveDay := f.shift(-6)                                                   // day 5 of the window
	f.exec(`UPDATE project_task SET project_id = $2 WHERE id = $1`, task, b) // closes A's span, opens B's
	f.exec(`UPDATE project_task_stage SET left_at = $2 WHERE task_id = $1 AND project_id = $3 AND left_at IS NOT NULL`, task, f.on(moveDay), a)
	f.exec(`UPDATE project_task_stage SET entered_at = $2 WHERE task_id = $1 AND project_id = $3 AND left_at IS NULL`, task, f.on(moveDay), b)

	ma := f.metricsBody(f.caller(u), a)
	mb := f.metricsBody(f.caller(u), b)
	metricsClose(t, "A day 4 scope_hours", metricsFloat(f.metricsPoint(ma, f.shift(-7))["scope_hours"]), 4)
	metricsClose(t, "A day 5 scope_hours", metricsFloat(f.metricsPoint(ma, moveDay)["scope_hours"]), 0)
	metricsClose(t, "B day 5 scope_hours", metricsFloat(f.metricsPoint(mb, moveDay)["scope_hours"]), 4)
}
