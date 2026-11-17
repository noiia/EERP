package project

import (
	"net/http"
	"time"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// forwardPass is the PERT forward pass over the Kahn topological order,
// adding extra[id] days to each task's duration. It returns every task's
// early start and finish, the project finish (the longest path, in days),
// the topological order, and ok — false on a cycle. Links to unknown tasks
// are ignored.
func forwardPass(tasks []calcTask, links []calcLink, extra map[uuid.UUID]float64) (es, ef map[uuid.UUID]float64, finish float64, order []uuid.UUID, ok bool) {
	dur := make(map[uuid.UUID]float64, len(tasks))
	for _, t := range tasks {
		dur[t.ID] = taskDays(t) + extra[t.ID]
	}
	deg := map[uuid.UUID]int{}
	out := map[uuid.UUID][]uuid.UUID{}
	for id := range dur {
		deg[id] = 0
	}
	for _, l := range links {
		if _, a := dur[l.From]; !a {
			continue
		}
		if _, b := dur[l.To]; !b {
			continue
		}
		out[l.From] = append(out[l.From], l.To)
		deg[l.To]++
	}
	var queue []uuid.UUID
	for id, d := range deg {
		if d == 0 {
			queue = append(queue, id)
		}
	}
	es = map[uuid.UUID]float64{}
	ef = map[uuid.UUID]float64{}
	order = make([]uuid.UUID, 0, len(dur))
	finish, seen := 0.0, 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		order = append(order, id)
		seen++
		e := es[id] + dur[id]
		ef[id] = e
		if e > finish {
			finish = e
		}
		for _, n := range out[id] {
			if e > es[n] {
				es[n] = e
			}
			if deg[n]--; deg[n] == 0 {
				queue = append(queue, n)
			}
		}
	}
	return es, ef, finish, order, seen == len(dur)
}

// scheduleRow is one task's critical-path figures, in day offsets from the
// schedule's start.
type scheduleRow struct {
	ID          uuid.UUID
	EarlyStart  float64
	EarlyFinish float64
	LateStart   float64
	LateFinish  float64
	Slack       float64
	Critical    bool
}

// schedule runs the forward pass (shared with projectFinish), then the
// backward pass over its reverse topological order: a task's late finish is
// the project finish when it has no successor, else the earliest of its
// successors' late starts. Slack is late start minus early start and a task
// is critical below 1e-6 (the PERT convention of ADR-039). finish is the
// longest path in days; ok is false on a cycle, when rows is empty.
func schedule(tasks []calcTask, links []calcLink) (rows []scheduleRow, finish float64, ok bool) {
	rows = make([]scheduleRow, 0, len(tasks))
	es, ef, finish, order, ok := forwardPass(tasks, links, nil)
	if !ok {
		return rows, 0, false
	}
	dur := make(map[uuid.UUID]float64, len(tasks))
	succ := map[uuid.UUID][]uuid.UUID{}
	for _, t := range tasks {
		dur[t.ID] = taskDays(t)
	}
	for _, l := range links {
		if _, a := dur[l.From]; !a {
			continue
		}
		if _, b := dur[l.To]; !b {
			continue
		}
		succ[l.From] = append(succ[l.From], l.To)
	}
	lf := map[uuid.UUID]float64{}
	for i := len(order) - 1; i >= 0; i-- {
		id := order[i]
		late := finish
		for _, s := range succ[id] {
			if v := lf[s] - dur[s]; v < late {
				late = v
			}
		}
		lf[id] = late
	}
	for _, t := range tasks {
		ls := lf[t.ID] - dur[t.ID]
		slack := ls - es[t.ID]
		rows = append(rows, scheduleRow{
			ID:          t.ID,
			EarlyStart:  es[t.ID],
			EarlyFinish: ef[t.ID],
			LateStart:   ls,
			LateFinish:  lf[t.ID],
			Slack:       slack,
			Critical:    slack < 1e-6,
		})
	}
	return rows, finish, true
}

// scheduleTask is one task of the schedule answer (day offsets from start).
type scheduleTask struct {
	ID          uuid.UUID `json:"id"`
	EarlyStart  float64   `json:"early_start"`
	EarlyFinish float64   `json:"early_finish"`
	LateStart   float64   `json:"late_start"`
	LateFinish  float64   `json:"late_finish"`
	Slack       float64   `json:"slack"`
	Critical    bool      `json:"critical"`
}

// scheduleResponse is GET /api/v1/project/:id/schedule.
type scheduleResponse struct {
	Start      string         `json:"start"`
	FinishDays float64        `json:"finish_days"`
	Cycle      bool           `json:"cycle"`
	Tasks      []scheduleTask `json:"tasks"`
}

// Schedule handles GET /api/v1/project/:id/schedule: the project's critical
// path schedule. start is the project's date_start, else the earliest task's
// date_start, else today; the day offsets run from it. A dependency cycle
// answers cycle: true with an empty task list. An invisible project is a
// 404, so its series and task ids never reach an outsider or a mere task
// assignee.
func (h *Handler) Schedule(c *echo.Context) error {
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
	var dateStart *time.Time
	err = h.db.QueryRow(ctx, `SELECT date_start FROM project WHERE id = $1 AND tenant_id = $2`, id, tenant).Scan(&dateStart)
	if err != nil {
		return err
	}
	if dateStart == nil {
		err = h.db.QueryRow(ctx, `SELECT min(date_start) FROM project_task
			WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND date_start IS NOT NULL`, id, tenant).Scan(&dateStart)
		if err != nil {
			return err
		}
	}
	start := time.Now().UTC()
	if dateStart != nil {
		start = *dateStart
	}

	rows, err := h.db.Query(ctx, `SELECT id, planned_hours, date_start, deadline FROM project_task
		WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
	if err != nil {
		return err
	}
	defer rows.Close()
	var tasks []calcTask
	for rows.Next() {
		var t calcTask
		if err := rows.Scan(&t.ID, &t.PlannedHours, &t.DateStart, &t.Deadline); err != nil {
			return err
		}
		tasks = append(tasks, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	deps, err := h.db.Query(ctx, `SELECT task_id, depends_on_id FROM project_task_dependency
		WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
	if err != nil {
		return err
	}
	defer deps.Close()
	var links []calcLink
	for deps.Next() {
		var l calcLink
		if err := deps.Scan(&l.From, &l.To); err != nil {
			return err
		}
		links = append(links, l)
	}
	if err := deps.Err(); err != nil {
		return err
	}

	resp := scheduleResponse{Start: start.Format("2006-01-02"), Tasks: []scheduleTask{}}
	sched, finish, ok := schedule(tasks, links)
	if !ok {
		resp.Cycle = true
		return c.JSON(http.StatusOK, resp)
	}
	resp.FinishDays = finish
	for _, r := range sched {
		resp.Tasks = append(resp.Tasks, scheduleTask{ID: r.ID, EarlyStart: r.EarlyStart, EarlyFinish: r.EarlyFinish,
			LateStart: r.LateStart, LateFinish: r.LateFinish, Slack: r.Slack, Critical: r.Critical})
	}
	return c.JSON(http.StatusOK, resp)
}
