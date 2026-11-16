package project

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestRisk_Schema(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	p := f.project(uuid.New(), "everyone")
	risk := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'R', 'quality', 2, 1, 3) RETURNING id`, f.tenant, p)

	var crit, eff *int
	read := func() {
		t.Helper()
		if err := f.app.DB.QueryRow(ctx, `SELECT criticity, severity_effective FROM project_risk WHERE id = $1`, risk).Scan(&crit, &eff); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if crit == nil || *crit != 6 || eff == nil || *eff != 3 {
		t.Fatalf("criticity/severity_effective = %v/%v, want 6/3", crit, eff)
	}
	f.exec(`UPDATE project_risk SET severity = NULL WHERE id = $1`, risk)
	read()
	if crit != nil {
		t.Errorf("criticity = %d, want NULL without any severity", *crit)
	}

	if _, err := f.app.DB.Exec(ctx, `INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood) VALUES ($1, $2, 'X', 'cost', 4)`, f.tenant, p); err == nil {
		t.Error("likelihood 4 accepted")
	}

	for sev, ok := range map[int]bool{4: true, 5: false} {
		_, err := f.app.DB.Exec(ctx, `INSERT INTO project_risk (tenant_id, project_id, name, impact_on, severity) VALUES ($1, $2, 'S', 'cost', $3)`, f.tenant, p, sev)
		if (err == nil) != ok {
			t.Errorf("severity %d: accepted = %v, want %v", sev, err == nil, ok)
		}
	}

	task := f.task(p, nil, nil)
	link := `INSERT INTO project_risk_task (tenant_id, project_id, risk_id, task_id) VALUES ($1, $2, $3, $4)`
	f.exec(link, f.tenant, p, risk, task)
	if _, err := f.app.DB.Exec(ctx, link, f.tenant, p, risk, task); err == nil {
		t.Error("duplicate live risk/task link accepted")
	}
}

func TestRisk_CategorySeed(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.exec(`INSERT INTO company (tenant_id, name) VALUES ($1, 'C')`, f.tenant)
	t.Cleanup(func() {
		_, _ = f.app.DB.Exec(ctx, `DELETE FROM project_risk_category WHERE tenant_id = $1`, f.tenant)
		_, _ = f.app.DB.Exec(ctx, `DELETE FROM company WHERE tenant_id = $1`, f.tenant)
	})
	count := func() (n int) {
		if err := f.app.DB.QueryRow(ctx, `SELECT count(*) FROM project_risk_category WHERE tenant_id = $1
			AND name IN ('Internal', 'Environment', 'Financial', 'Project management')`, f.tenant).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for i := 0; i < 2; i++ {
		if err := (&projectModule{}).Migrate(ctx, f.app.DB); err != nil {
			t.Fatal(err)
		}
	}
	if n := count(); n != 4 {
		t.Errorf("seeded categories = %d, want 4 (and no duplicates on a second Migrate)", n)
	}
}

func TestRiskRules(t *testing.T) {
	f := newFixture(t)
	other := f.sibling()
	m, v := uuid.New(), uuid.New()
	me, viewer := f.caller(m), f.caller(v)
	p, q := f.project(m, "everyone"), f.project(m, "everyone")
	phase, sub := f.task(p, nil, nil), f.task(p, nil, nil)
	f.task(p, &sub, nil)
	subtask := f.task(p, &phase, nil)
	qTask := f.task(q, nil, nil)
	foreignCat := other.id(`INSERT INTO project_risk_category (tenant_id, name) VALUES ($1, 'X') RETURNING id`, other.tenant)
	visitor := f.user("website")
	risk := func(extra map[string]any) map[string]any {
		body := map[string]any{"project_id": p, "name": "R"}
		for k, val := range extra {
			body[k] = val
		}
		return body
	}
	existing := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on) VALUES ($1, $2, 'E', 'quality') RETURNING id`, f.tenant, p)
	path := "project_risk/" + existing.String()
	f.run(t, []writeCase{
		{"create", me, http.MethodPost, "project_risk", risk(map[string]any{"phase_task_id": phase, "likelihood": 3, "severity": 4}), 201},
		{"viewer creates", viewer, http.MethodPost, "project_risk", risk(nil), 201},
		{"no project", me, http.MethodPost, "project_risk", map[string]any{"name": "R"}, 422},
		{"project change", me, http.MethodPut, path, map[string]any{"project_id": q}, 422},
		{"likelihood 0", me, http.MethodPost, "project_risk", risk(map[string]any{"likelihood": 0}), 422},
		{"likelihood 4", me, http.MethodPost, "project_risk", risk(map[string]any{"likelihood": 4}), 422},
		{"severity 5", me, http.MethodPost, "project_risk", risk(map[string]any{"severity": 5}), 422},
		{"impact time", me, http.MethodPost, "project_risk", risk(map[string]any{"impact_on": "time"}), 422},
		{"phase is a subtask", me, http.MethodPost, "project_risk", risk(map[string]any{"phase_task_id": subtask}), 422},
		{"phase of another project", me, http.MethodPost, "project_risk", risk(map[string]any{"phase_task_id": qTask}), 422},
		{"foreign category", me, http.MethodPost, "project_risk", risk(map[string]any{"category_id": foreignCat}), 422},
		{"website responsible", me, http.MethodPost, "project_risk", risk(map[string]any{"responsible_id": visitor}), 422},
		{"viewer deletes", viewer, http.MethodDelete, path, nil, 403},
		{"manager deletes", me, http.MethodDelete, path, nil, 204},
	})
	t.Run("restore", func(t *testing.T) {
		cat := f.id(`INSERT INTO project_risk_category (tenant_id, name) VALUES ($1, 'Gone') RETURNING id`, f.tenant)
		r := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, category_id) VALUES ($1, $2, 'D', 'quality', $3) RETURNING id`, f.tenant, p, cat)
		f.exec(`UPDATE project_risk SET deleted_at = now() WHERE id = $1`, r)
		f.exec(`UPDATE project_risk_category SET deleted_at = now() WHERE id = $1`, cat)
		url := "project_risk/" + r.String() + "/restore"
		if code, body := f.do(viewer, http.MethodPost, url, nil); code != http.StatusForbidden {
			t.Errorf("viewer restores: %d %v, want 403", code, body)
		}
		if code, body := f.do(me, http.MethodPost, url, nil); code != http.StatusOK {
			t.Errorf("manager restores: %d %v, want 200", code, body)
		}
	})
	t.Run("impact defaults to delay", func(t *testing.T) {
		code, body := f.do(me, http.MethodPost, "project_risk", risk(nil))
		if code != http.StatusCreated || body["impact_on"] != "delay" {
			t.Fatalf("%d %v", code, body)
		}
	})
}

func TestRiskLinkRules(t *testing.T) {
	f := newFixture(t)
	m := uuid.New()
	me := f.caller(m)
	p, q := f.project(m, "everyone"), f.project(m, "everyone")
	t1, t2, t3, qt := f.task(p, nil, nil), f.task(p, nil, nil), f.task(p, nil, nil), f.task(q, nil, nil)
	mk := func(impact string) uuid.UUID {
		return f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on) VALUES ($1, $2, 'R', $3) RETURNING id`, f.tenant, p, impact)
	}
	delay, cost, quality := mk("delay"), mk("cost"), mk("quality")
	link := func(risk, task uuid.UUID, extra map[string]any) map[string]any {
		body := map[string]any{"risk_id": risk, "task_id": task}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	f.run(t, []writeCase{
		{"other project's task", me, http.MethodPost, "project_risk_task", link(delay, qt, map[string]any{"delay_days": 1}), 422},
		{"delay without days", me, http.MethodPost, "project_risk_task", link(delay, t1, nil), 422},
		{"cost without hours", me, http.MethodPost, "project_risk_task", link(cost, t1, nil), 422},
		{"negative", me, http.MethodPost, "project_risk_task", link(delay, t1, map[string]any{"delay_days": -1}), 422},
		{"delay ok", me, http.MethodPost, "project_risk_task", link(delay, t1, map[string]any{"delay_days": 2}), 201},
		{"duplicate", me, http.MethodPost, "project_risk_task", link(delay, t1, map[string]any{"delay_days": 2}), 409},
		{"cost ok", me, http.MethodPost, "project_risk_task", link(cost, t2, map[string]any{"extra_hours": 8}), 201},
		{"quality bare", me, http.MethodPost, "project_risk_task", link(quality, t3, nil), 201},
	})
	code, body := f.do(me, http.MethodPost, "project_risk_task", link(quality, t1, map[string]any{"project_id": q}))
	if code != http.StatusCreated || body["project_id"] != p.String() {
		t.Fatalf("%d %v: project_id must be the risk's", code, body)
	}
}

func TestRiskCategoryRules(t *testing.T) {
	f := newFixture(t)
	me := f.caller(uuid.New())
	f.run(t, []writeCase{
		{"empty name", me, http.MethodPost, "project_risk_category", map[string]any{"name": " ", "color": "#aabbcc"}, 422},
		{"short color", me, http.MethodPost, "project_risk_category", map[string]any{"name": "N", "color": "#ABC"}, 422},
	})
	code, body := f.do(me, http.MethodPost, "project_risk_category", map[string]any{"name": "N", "color": "#AABBCC"})
	if code != http.StatusCreated || body["color"] != "#aabbcc" {
		t.Fatalf("%d %v, want 201 with #aabbcc", code, body)
	}
}

func TestRiskScope_MembersOnly(t *testing.T) {
	f := newFixture(t)
	m, assignee := uuid.New(), uuid.New()
	me, stranger, assigned := f.caller(m), f.caller(uuid.New()), f.caller(assignee)
	p := f.project(m, "members")
	task := f.task(p, nil, nil)
	f.assign(p, task, assignee)
	risk := f.id(`INSERT INTO project_risk (tenant_id, project_id, name, impact_on, likelihood, detectability, severity)
		VALUES ($1, $2, 'R', 'quality', 2, 2, 2) RETURNING id`, f.tenant, p)
	f.exec(`INSERT INTO project_risk_task (tenant_id, project_id, risk_id, task_id) VALUES ($1, $2, $3, $4)`, f.tenant, p, risk, task)

	if f.total(me, "project_risk_task?filter[project_id]="+p.String()) != 1 {
		t.Fatal("manager does not see the link")
	}
	if code, _ := f.get(stranger, "project_risk/"+risk.String()); code != http.StatusNotFound {
		t.Errorf("stranger get: %d, want 404", code)
	}
	if code, _ := f.get(assigned, "project_risk/"+risk.String()); code != http.StatusNotFound {
		t.Errorf("assignee get: %d, want 404", code)
	}
	if n := f.total(stranger, "project_risk?filter[project_id]="+p.String()); n != 0 {
		t.Errorf("stranger lists %d risks", n)
	}
	if n := f.total(stranger, "project_risk_task"); n != 0 {
		t.Errorf("stranger lists %d links", n)
	}
	for _, q := range []string{"project_risk?distinct=impact_on", "project_risk?aggregate=count&value=criticity"} {
		code, body := f.get(stranger, q)
		if code != http.StatusOK {
			t.Fatalf("%s: %d %v", q, code, body)
		}
		// An ungrouped aggregate over nothing still answers one zero row.
		for _, k := range []string{"data", "groups", "values"} {
			l, _ := body[k].([]any)
			for _, g := range l {
				if gm, ok := g.(map[string]any); !ok || (gm["count"] != nil && gm["count"] != float64(0)) {
					t.Errorf("%s leaks %v", q, body)
				}
			}
		}
	}
}
