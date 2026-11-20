package project

import (
	"context"
	"encoding/json"
	"fmt"

	"core/internal/settings"
	"core/orm"
)

// The task list's default Graph mode: the project's indicators (indicators.go)
// as stat and pie tiles, seeded in every company where the entity has no
// layout yet. An admin's own layout, even an empty one, is never touched. Each
// tile reads one indicator of the project the list is filtered on (`source`,
// graph-indicators.ts); without that filter it asks for one.

type presetTile struct {
	ID     string         `json:"id"`
	X      int            `json:"x"`
	Y      int            `json:"y"`
	W      int            `json:"w"`
	H      int            `json:"h"`
	Type   string         `json:"type"`
	Title  string         `json:"title"`
	Config map[string]any `json:"config"`
}

func indicator(key, unit string) map[string]any {
	src := map[string]any{"scopeField": "project_id", "scopeEntity": "project", "scopeLabel": "Project", "path": "indicators", "key": key}
	if unit != "" {
		src["unit"] = unit
	}
	return map[string]any{"source": src}
}

var taskGraphPreset = []presetTile{
	{ID: "prj-done", X: 0, Y: 0, W: 8, H: 4, Type: "stat", Title: "Tasks done (%)", Config: indicator("done_pct", "%")},
	{ID: "prj-elapsed", X: 8, Y: 0, W: 8, H: 4, Type: "stat", Title: "Project time elapsed (%)", Config: indicator("time_elapsed_pct", "%")},
	{ID: "prj-spent", X: 16, Y: 0, W: 8, H: 4, Type: "stat", Title: "Hours spent on planned (%)", Config: indicator("spent_pct", "%")},
	{ID: "prj-critical", X: 0, Y: 4, W: 12, H: 4, Type: "stat", Title: "Critical path (days)", Config: indicator("critical_path_days", "d")},
	{ID: "prj-planned", X: 12, Y: 4, W: 12, H: 4, Type: "stat", Title: "Planned hours, all tasks", Config: indicator("planned_hours", "h")},
	{ID: "prj-stage", X: 0, Y: 8, W: 8, H: 8, Type: "pie", Title: "Tasks by stage", Config: indicator("by_stage", "")},
	{ID: "prj-color", X: 8, Y: 8, W: 8, H: 8, Type: "pie", Title: "Tasks by color group", Config: indicator("by_color", "")},
	{ID: "prj-wbs", X: 16, Y: 8, W: 8, H: 8, Type: "pie", Title: "Tasks by top-level WBS task", Config: indicator("by_wbs_l1", "")},
	{ID: "prj-obs1", X: 0, Y: 16, W: 12, H: 8, Type: "pie", Title: "OBS contacts per level 1", Config: indicator("obs_contacts_l1", "")},
	{ID: "prj-obs2", X: 12, Y: 16, W: 12, H: 8, Type: "pie", Title: "OBS contacts per level 2", Config: indicator("obs_contacts_l2", "")},
}

// seedGraphPresets runs from Migrate; it skips while the settings or company
// tables don't exist yet (the next boot seeds). Soft-deleted rows count as
// present, so a removed layout stays removed.
func seedGraphPresets(ctx context.Context, db *orm.DB) error {
	var ready bool
	if err := db.QueryRow(ctx, `SELECT to_regclass('app_settings') IS NOT NULL AND to_regclass('company') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		return err
	}
	layout, err := json.Marshal(map[string]any{"tiles": taskGraphPreset})
	if err != nil {
		return err
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO app_settings (tenant_id, company_id, key, value)
		SELECT c.tenant_id, c.id, $1, $2 FROM company c
		WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM app_settings s
			WHERE s.tenant_id = c.tenant_id AND s.company_id = c.id AND s.key = $1)`,
		settings.ViewGraphKey("project_task"), string(layout)); err != nil {
		return fmt.Errorf("project: seed graph: %w", err)
	}
	return nil
}
