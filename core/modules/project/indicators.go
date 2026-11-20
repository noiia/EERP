package project

import (
	"context"
	"net/http"
	"time"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// indicators.go serves GET /api/v1/project/:id/indicators: one project's
// headline figures, read by the task list's default Graph tiles (a stat or pie
// tile whose config names an indicator `source`). Each key is either a number
// (null when it can't be computed) or a list of {label, value[, color]} slices.
// The Graph tiles aggregate one entity's rows; these figures span several
// tables (the project's dates, stages, color groups, the PERT schedule, the
// OBS chart), so the project computes them.

type indicatorSlice struct {
	Label string  `json:"label"`
	Value float64 `json:"value"`
	Color *string `json:"color,omitempty"`
}

// Labels the frontend translates (the shell catalog holds them).
const (
	noStageLabel = "No stage"
	noColorLabel = "No color group"
	unnamedLabel = "Unnamed"
)

// Indicators handles the route. An invisible project is a 404, like metrics.
func (h *Handler) Indicators(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	visible, err := orm.CanSeeRecord(ctx, h.db, "project", id)
	if err != nil {
		return err
	}
	if !visible {
		return respond(c, errNotFound)
	}
	out, err := h.projectIndicators(ctx, tenant, id, time.Now().UTC())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}

func pct(num, den float64) *float64 {
	if den <= 0 {
		return nil
	}
	v := num / den * 100
	return &v
}

func (h *Handler) projectIndicators(ctx context.Context, tenant, id uuid.UUID, now time.Time) (map[string]any, error) {
	out := map[string]any{}

	var total, done int
	var planned, spent float64
	var start, end *time.Time
	if err := h.db.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM project_task t WHERE t.project_id = p.id AND t.tenant_id = p.tenant_id AND t.deleted_at IS NULL),
			(SELECT count(*) FROM project_task t WHERE t.project_id = p.id AND t.tenant_id = p.tenant_id AND t.deleted_at IS NULL AND t.closed),
			p.planned_hours, p.spent_hours, p.date_start, p.date_end
		FROM project p WHERE p.id = $1 AND p.tenant_id = $2`, id, tenant).Scan(&total, &done, &planned, &spent, &start, &end); err != nil {
		return nil, err
	}
	out["tasks_total"] = total
	out["tasks_done"] = done
	out["done_pct"] = pct(float64(done), float64(total))
	out["planned_hours"] = planned
	out["spent_hours"] = spent
	// Spent over planned hours; may pass 100 (an overrun).
	out["spent_pct"] = pct(spent, planned)
	// The share of the project's span already elapsed: 0 before it starts,
	// over 100 once its end date is past.
	var elapsed *float64
	if start != nil && end != nil {
		if v := pct(now.Sub(*start).Hours(), end.Sub(*start).Hours()); v != nil {
			e := max(*v, 0)
			elapsed = &e
		}
	}
	out["time_elapsed_pct"] = elapsed

	// The PERT critical path, in days and hours (8 h a day); null on a cycle.
	tasks, links, err := h.scheduleInput(ctx, tenant, id)
	if err != nil {
		return nil, err
	}
	out["critical_path_days"], out["critical_path_hours"] = nil, nil
	if _, finish, ok := schedule(tasks, links); ok {
		out["critical_path_days"] = finish
		out["critical_path_hours"] = finish * hoursPerDay
	}

	queries := []struct {
		key, sql string
		args     []any
	}{
		// Tasks per kanban column, in column order.
		{"by_stage", `SELECT coalesce(s.name, $3), count(*), NULL::text
			FROM project_task t LEFT JOIN project_stage s ON s.id = t.stage_id AND s.deleted_at IS NULL
			WHERE t.project_id = $1 AND t.tenant_id = $2 AND t.deleted_at IS NULL
			GROUP BY s.id, s.name, s.sequence ORDER BY s.sequence NULLS LAST, s.name`, []any{id, tenant, noStageLabel}},
		// Tasks per color group (a task in two groups counts in both), in the
		// group's own color, then the tasks in none.
		{"by_color", `SELECT g.name, count(*), g.color
			FROM project_task_color l
			JOIN project_task t ON t.id = l.task_id AND t.deleted_at IS NULL
			JOIN project_color g ON g.id = l.color_id AND g.deleted_at IS NULL
			WHERE t.project_id = $1 AND l.tenant_id = $2 AND l.deleted_at IS NULL
			GROUP BY g.id, g.name, g.color
			UNION ALL
			SELECT $3, count(*), NULL FROM project_task t
			WHERE t.project_id = $1 AND t.tenant_id = $2 AND t.deleted_at IS NULL AND NOT EXISTS (
				SELECT 1 FROM project_task_color l JOIN project_color g ON g.id = l.color_id AND g.deleted_at IS NULL
				WHERE l.task_id = t.id AND l.deleted_at IS NULL)
			HAVING count(*) > 0`, []any{id, tenant, noColorLabel}},
		// Tasks per top-level task of the WBS, each counting itself and every
		// task below it, in order-number order.
		{"by_wbs_l1", `WITH RECURSIVE tree AS (
				SELECT id, id AS root FROM project_task
				WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND parent_id IS NULL
				UNION ALL
				SELECT c.id, tree.root FROM project_task c JOIN tree ON c.parent_id = tree.id
				WHERE c.deleted_at IS NULL
			)
			SELECT concat_ws(' - ', r.wbs_number, nullif(r.name, '')), count(*), NULL::text
			FROM tree JOIN project_task r ON r.id = tree.root
			GROUP BY r.id, r.wbs_number, r.name, r.sequence ORDER BY r.sequence, r.name`, []any{id, tenant}},
	}
	for _, q := range queries {
		slices, err := h.indicatorSlices(ctx, q.sql, q.args...)
		if err != nil {
			return nil, err
		}
		out[q.key] = slices
	}

	// Contacts on the OBS chart per level-1 and level-2 box: each counts the
	// contact boxes of its whole subtree, itself included.
	for key, depth := range map[string]int{"obs_contacts_l1": 1, "obs_contacts_l2": 2} {
		slices, err := h.indicatorSlices(ctx, `WITH RECURSIVE tree AS (
				SELECT id, 1 AS depth, ARRAY[id] AS path FROM project_obs_box
				WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND parent_id IS NULL
				UNION ALL
				SELECT c.id, tree.depth + 1, tree.path || c.id FROM project_obs_box c JOIN tree ON c.parent_id = tree.id
				WHERE c.deleted_at IS NULL AND NOT c.id = ANY(tree.path)
			)
			SELECT coalesce(nullif(b.title, ''), nullif(ct.name, ''), nullif(u.display_name, ''), nullif(left(b.text, 60), ''), $3),
				count(*) FILTER (WHERE m.kind = 'contact'), b.color
			FROM tree h
			JOIN project_obs_box b ON b.id = h.id
			LEFT JOIN contact ct ON ct.id = b.contact_id
			LEFT JOIN users u ON u.id = b.user_id
			JOIN tree d ON d.path[$4] = h.id
			JOIN project_obs_box m ON m.id = d.id
			WHERE h.depth = $4
			GROUP BY b.id, b.title, ct.name, u.display_name, b.text, b.color, b.x
			HAVING count(*) FILTER (WHERE m.kind = 'contact') > 0
			ORDER BY b.x, 1`, id, tenant, unnamedLabel, depth)
		if err != nil {
			return nil, err
		}
		out[key] = slices
	}
	return out, nil
}

func (h *Handler) indicatorSlices(ctx context.Context, sql string, args ...any) ([]indicatorSlice, error) {
	rows, err := h.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []indicatorSlice{}
	for rows.Next() {
		var s indicatorSlice
		var n int64
		if err := rows.Scan(&s.Label, &n, &s.Color); err != nil {
			return nil, err
		}
		s.Value = float64(n)
		out = append(out, s)
	}
	return out, rows.Err()
}
