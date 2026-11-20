package project

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestIndicators covers GET /api/v1/project/:id/indicators: the ratios, the
// critical path, and every pie (stage, color group, WBS level 1, OBS levels 1
// and 2), plus the visibility rule.
func TestIndicators(t *testing.T) {
	f := newFixture(t)
	mgr := uuid.New()
	p := f.project(mgr, "members")
	f.exec(`UPDATE project SET date_start = now() - interval '10 days', date_end = now() + interval '30 days' WHERE id = $1`, p)

	// WBS: a (8 h) with child b (16 h), c (8 h) on its own; c depends on b.
	a := f.task(p, nil, nil)
	b := f.task(p, &a, nil)
	c := f.task(p, nil, nil)
	f.exec(`UPDATE project_task SET name = 'Design', planned_hours = 8 WHERE id = $1`, a)
	f.exec(`UPDATE project_task SET planned_hours = 16 WHERE id = $1`, b)
	f.exec(`UPDATE project_task SET name = 'Ship', planned_hours = 8, stage_id = $2 WHERE id = $1`, c, f.stage(p, "Done"))
	f.dependency(p, c, b)
	f.timesheet(p, a, 4)
	red := f.id(`INSERT INTO project_color (tenant_id, name, color) VALUES ($1, 'Red', '#ff0000') RETURNING id`, f.tenant)
	f.exec(`INSERT INTO project_task_color (tenant_id, project_id, task_id, color_id) VALUES ($1, $2, $3, $4)`, f.tenant, p, a, red)
	f.exec(`INSERT INTO project_task_color (tenant_id, project_id, task_id, color_id) VALUES ($1, $2, $3, $4)`, f.tenant, p, b, red)

	// OBS: root "Board" → "Dev" (2 contacts below) and a contact box itself.
	box := func(parent *uuid.UUID, kind string, title string, contact *uuid.UUID) uuid.UUID {
		return f.id(`INSERT INTO project_obs_box (tenant_id, project_id, parent_id, kind, title, contact_id, x, y)
			VALUES ($1, $2, $3, $4, $5, $6, 0, 0) RETURNING id`, f.tenant, p, parent, kind, title, contact)
	}
	ct := f.contactOf("contact")
	root := box(nil, "text", "Board", nil)
	dev := box(&root, "text", "Dev", nil)
	box(&dev, "contact", "", &ct)
	box(&dev, "contact", "", &ct)
	box(&root, "contact", "CFO", &ct)

	code, body := f.get(f.caller(mgr), "project/"+p.String()+"/indicators")
	if code != http.StatusOK {
		t.Fatalf("indicators: %d %v", code, body)
	}
	near := func(key string, want float64) {
		t.Helper()
		got, ok := body[key].(float64)
		if !ok || got < want-0.6 || got > want+0.6 {
			t.Errorf("%s = %v, want %v", key, body[key], want)
		}
	}
	near("tasks_total", 3)
	near("tasks_done", 1)
	near("done_pct", 100.0/3)
	near("planned_hours", 32)
	near("spent_pct", 4.0/32*100)
	near("time_elapsed_pct", 25)
	near("critical_path_days", 3) // b (2 d) then c (1 d)
	near("critical_path_hours", 24)

	slices := func(key string) map[string]float64 {
		t.Helper()
		out := map[string]float64{}
		list, ok := body[key].([]any)
		if !ok {
			t.Fatalf("%s is %v, want a list", key, body[key])
		}
		for _, s := range list {
			m := s.(map[string]any)
			out[m["label"].(string)] = m["value"].(float64)
		}
		return out
	}
	eq := func(key string, want map[string]float64) {
		t.Helper()
		got := slices(key)
		if len(got) != len(want) {
			t.Errorf("%s = %v, want %v", key, got, want)
			return
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s = %v, want %v", key, got, want)
				return
			}
		}
	}
	eq("by_stage", map[string]float64{"New": 2, "Done": 1})
	eq("by_color", map[string]float64{"Red": 2, noColorLabel: 1})
	eq("by_wbs_l1", map[string]float64{"1 - Design": 2, "2 - Ship": 1})
	eq("obs_contacts_l1", map[string]float64{"Board": 3})
	eq("obs_contacts_l2", map[string]float64{"Dev": 2, "CFO": 1})
	if body["by_color"].([]any)[0].(map[string]any)["color"] != "#ff0000" {
		t.Errorf("a color group's slice carries its color: %v", body["by_color"])
	}

	t.Run("a non-member gets a 404", func(t *testing.T) {
		if code, _ := f.get(f.caller(uuid.New()), "project/"+p.String()+"/indicators"); code != http.StatusNotFound {
			t.Errorf("got %d, want 404", code)
		}
	})
	t.Run("an empty project has null ratios and empty pies", func(t *testing.T) {
		q := f.project(mgr, "everyone")
		code, body := f.get(f.caller(mgr), "project/"+q.String()+"/indicators")
		if code != http.StatusOK || body["done_pct"] != nil || body["time_elapsed_pct"] != nil || len(body["by_stage"].([]any)) != 0 {
			t.Errorf("empty project: %d %v", code, body)
		}
	})
}
