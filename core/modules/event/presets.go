package event

import (
	"context"
	"encoding/json"
	"fmt"

	"core/internal/settings"
	"core/orm"
)

// The Event app's dashboard: Graph-mode tile layouts and a calculated field,
// seeded in every company where absent (the views.<entity>.fields defaults —
// kanban, calendar, graphs on — are the descriptors' viewModeDefaults, no
// seeding needed). An admin's own layout, even an empty one, is never touched.

type presetTile struct {
	ID     string         `json:"id"`
	X      int            `json:"x"`
	Y      int            `json:"y"`
	W      int            `json:"w"`
	H      int            `json:"h"`
	Type   string         `json:"type"`
	Title  string         `json:"title,omitempty"`
	Config map[string]any `json:"config"`
}

// graphPresets: config keys are graph-widgets.tsx's (see internal/devseed).
var graphPresets = map[string][]presetTile{
	"event_booking": {
		{ID: "evb-count", X: 0, W: 6, H: 3, Type: "stat", Title: "Bookings", Config: map[string]any{"field": "id", "aggregate": "count"}},
		{ID: "evb-seats", X: 6, W: 6, H: 3, Type: "stat", Title: "Seats booked", Config: map[string]any{"field": "seats", "aggregate": "sum"}},
		{ID: "evb-weekly", X: 0, Y: 3, W: 16, H: 8, Type: "bar", Title: "Seats per week by status",
			Config: map[string]any{"xField": "starts_at", "yField": "seats", "aggregate": "sum", "bucket": "week", "seriesField": "status", "mode": "stacked"}},
		{ID: "evb-status", X: 16, Y: 3, W: 8, H: 8, Type: "pie", Title: "Attendance", Config: map[string]any{"groupByField": "status", "valueField": "seats"}},
	},
	"event_session": {
		{ID: "evs-fill", X: 0, W: 6, H: 3, Type: "stat", Title: "Average fill rate (%)", Config: map[string]any{"field": "calc_fill_rate", "aggregate": "avg"}},
		{ID: "evs-seats", X: 6, W: 6, H: 3, Type: "stat", Title: "Seats taken", Config: map[string]any{"field": "seats_taken", "aggregate": "sum"}},
		{ID: "evs-weekly", X: 0, Y: 3, W: 24, H: 8, Type: "xy", Title: "Weekly fill rate (%)",
			Config: map[string]any{"xField": "starts_at", "yField": "calc_fill_rate", "aggregate": "avg", "bucket": "week"}},
	},
}

// fillRate is a session's seats_taken over capacity in percent (x/0 reads 0).
var fillRate = struct{ entity, key, label, formula string }{
	"event_session", "calc_fill_rate", "Fill rate (%)", "seats_taken / capacity * 100",
}

// seedPresets runs from Migrate. It skips when the settings, company or
// graph_field tables don't exist yet (a fresh DB where those modules haven't
// migrated); the next boot seeds them. NOT EXISTS rather than ON CONFLICT: on
// a fresh DB the tables can exist before their unique indexes (created in
// their own modules' Migrate), and migrations already run under the schema
// lock. Soft-deleted rows count as present, so a removed layout stays removed.
func seedPresets(ctx context.Context, db *orm.DB) error {
	var ready bool
	if err := db.QueryRow(ctx, `SELECT to_regclass('app_settings') IS NOT NULL AND to_regclass('company') IS NOT NULL
		AND to_regclass('graph_field') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		return err
	}
	for entity, tiles := range graphPresets {
		layout, err := json.Marshal(map[string]any{"tiles": tiles})
		if err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO app_settings (tenant_id, company_id, key, value)
			SELECT c.tenant_id, c.id, $1, $2 FROM company c
			WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM app_settings s
				WHERE s.tenant_id = c.tenant_id AND s.company_id = c.id AND s.key = $1)`,
			settings.ViewGraphKey(entity), string(layout)); err != nil {
			return fmt.Errorf("event: seed %s graph: %w", entity, err)
		}
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO graph_field (tenant_id, entity, field_key, label, formula, roles, dated)
		SELECT DISTINCT c.tenant_id, $1, $2, $3, $4, '', false FROM company c
		WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM graph_field g
			WHERE g.tenant_id = c.tenant_id AND g.entity = $1 AND g.field_key = $2)`,
		fillRate.entity, fillRate.key, fillRate.label, fillRate.formula); err != nil {
		return fmt.Errorf("event: seed %s: %w", fillRate.key, err)
	}
	return nil
}
