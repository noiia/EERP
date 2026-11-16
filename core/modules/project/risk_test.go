package project

import (
	"context"
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
		if err := f.app.DB.QueryRow(ctx, `SELECT count(*) FROM project_risk_category WHERE tenant_id = $1`, f.tenant).Scan(&n); err != nil {
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
