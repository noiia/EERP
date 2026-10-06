package event

import (
	"context"
	"encoding/json"
	"testing"

	"core/internal/settings"
	"core/internal/testdb"
	_ "core/modules/company"
	_ "core/modules/graphfield"
	_ "core/modules/settings"

	"github.com/google/uuid"
)

func TestMigrate_SeedsGraphPresetsOnlyWhereAbsent(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "company", "settings", "graphfield", "event")
	tenant := uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{"app_settings", "graph_field", "company"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	var a, b uuid.UUID
	for _, id := range []*uuid.UUID{&a, &b} {
		if err := app.DB.QueryRow(ctx, `INSERT INTO company (tenant_id, name) VALUES ($1, 'Co') RETURNING id`, tenant).Scan(id); err != nil {
			t.Fatal(err)
		}
	}
	custom := `{"tiles":[]}`
	if _, err := app.DB.Exec(ctx, `INSERT INTO app_settings (tenant_id, company_id, key, value) VALUES ($1, $2, $3, $4)`,
		tenant, b, settings.ViewGraphKey("event_booking"), custom); err != nil {
		t.Fatal(err)
	}

	for range 2 { // idempotent
		if err := (&eventModule{}).Migrate(ctx, app.DB); err != nil {
			t.Fatal(err)
		}
	}

	layout := func(company uuid.UUID, entity string) string {
		var v string
		_ = app.DB.QueryRow(ctx, `SELECT value FROM app_settings WHERE tenant_id = $1 AND company_id = $2 AND key = $3`,
			tenant, company, settings.ViewGraphKey(entity)).Scan(&v)
		return v
	}
	for _, entity := range []string{"event_booking", "event_session"} {
		var got struct {
			Tiles []map[string]any `json:"tiles"`
		}
		if err := json.Unmarshal([]byte(layout(a, entity)), &got); err != nil || len(got.Tiles) == 0 {
			t.Errorf("%s layout in company A = %q (%v), want seeded tiles", entity, layout(a, entity), err)
		}
	}
	if layout(b, "event_booking") != custom {
		t.Errorf("company B's own layout was overwritten: %q", layout(b, "event_booking"))
	}
	var formula string
	if err := app.DB.QueryRow(ctx, `SELECT formula FROM graph_field WHERE tenant_id = $1 AND entity = 'event_session' AND field_key = 'calc_fill_rate'`,
		tenant).Scan(&formula); err != nil {
		t.Fatalf("calc_fill_rate not seeded: %v", err)
	}
}
