package project

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// The project's analytics series (ADR-041): the burndown scope/done, the
// earned-value pv/ev/ac and the spi/cpi ratios, the ideal line, the
// per-stage flow and the risk trend. The window runs from the project's
// date_start (else the earliest live task's created_at, else today) to
// max(today, date_end), capped at three years; the points are daily when
// the span is ≤ 120 days, weekly (Mondays) beyond, and today is always a
// point when it is in the window. Every figure is computed in SQL (one
// query per series, tenant-pinned, over generate_series); the scope
// membership over time comes from the project_task_stage intervals (they
// carry project_id), so a moved task counts in the old project only up
// to the move date.

const metricsDateLayout = "2006-01-02"

// The grid CTEs (params: $3 grid start, $4 grid end, $5 step, $6 the
// window's from — the UNION's lower bound): the main series walks
// generate_series plus today (a point is always added when today is in
// the window and not on the grid). The caller trims the grid end to
// today for the weekly bucket (today is the last point) and keeps the
// full window for the daily one; the single-date variant reuses the
// same aggregate body for today (spi/cpi) and for from (the ideal
// line's scope anchor).
const (
	metricsGridMain = `SELECT (gs)::date AS d FROM generate_series($3::date, $4::date, $5) gs
	UNION SELECT CURRENT_DATE WHERE CURRENT_DATE BETWEEN $6::date AND $4::date`
	metricsGridSingle = `SELECT $3::date AS d`
)

// metricsWindow reads the window's anchors: the project's dates, the
// earliest live task's creation (the fallback from) and today, plus
// pv_excluded (the live tasks without both dates, which PV excludes).
const metricsWindowSQL = `SELECT p.date_start::date::text,
       p.date_end::date::text,
       CURRENT_DATE::text,
       (SELECT min(t.created_at::date)::text FROM project_task t
        WHERE t.project_id = p.id AND t.tenant_id = $2 AND t.deleted_at IS NULL),
       (SELECT count(*) FROM project_task t
        WHERE t.project_id = p.id AND t.tenant_id = $2 AND t.deleted_at IS NULL
          AND (t.date_start IS NULL OR t.deadline IS NULL))::int
FROM project p
WHERE p.id = $1 AND p.tenant_id = $2`

// metricsSeries is one point per grid date (the grid comes in as the %s
// CTE). A task counts at a point when its stage interval covers the
// point (membership at the time), it existed (created) and it was alive
// (not yet deleted). A task's intervals are disjoint in time, so it
// appears at most once per point. pv spreads the planned hours over
// [date_start, deadline] (a task where deadline ≤ date_start counts
// fully from its deadline); ev is the planned hours of the tasks closed
// by the point (the burndown's done hours, kept as a separate field for
// the EVM views); ac is the live timesheets' hours dated by the point.
const metricsSeriesBody = `
WITH grid AS (
	%s
),
task_points AS (
	SELECT g.d AS d,
		t.planned_hours,
		t.closed_at,
		t.date_start,
		t.deadline,
		(h.entered_at::date <= g.d AND (h.left_at IS NULL OR h.left_at::date > g.d)) AS member,
		(t.created_at::date <= g.d) AS created,
		(t.deleted_at IS NULL OR t.deleted_at::date > g.d) AS alive
	FROM grid g
	JOIN project_task_stage h ON h.project_id = $1 AND h.tenant_id = $2
	JOIN project_task t ON t.id = h.task_id AND t.tenant_id = $2
)
SELECT g.d::text AS date,
	COALESCE(SUM(CASE WHEN tp.member AND tp.created AND tp.alive THEN tp.planned_hours END), 0)::float8 AS scope_hours,
	COUNT(*) FILTER (WHERE tp.member AND tp.created AND tp.alive)::int AS scope_tasks,
	COALESCE(SUM(CASE WHEN tp.member AND tp.created AND tp.alive AND tp.closed_at IS NOT NULL AND tp.closed_at::date <= g.d THEN tp.planned_hours END), 0)::float8 AS done_hours,
	COUNT(*) FILTER (WHERE tp.member AND tp.created AND tp.alive AND tp.closed_at IS NOT NULL AND tp.closed_at::date <= g.d)::int AS done_tasks,
	COALESCE(SUM(CASE WHEN tp.member AND tp.created AND tp.alive AND tp.date_start IS NOT NULL AND tp.deadline IS NOT NULL
		THEN tp.planned_hours * (CASE WHEN tp.deadline::date <= tp.date_start::date
			THEN CASE WHEN g.d >= tp.deadline::date THEN 1 ELSE 0 END::numeric
			ELSE GREATEST(0, LEAST(1, (g.d - tp.date_start::date)::numeric / (tp.deadline::date - tp.date_start::date)::numeric))
		END) END), 0)::float8 AS pv,
	COALESCE(SUM(CASE WHEN tp.member AND tp.created AND tp.alive AND tp.closed_at IS NOT NULL AND tp.closed_at::date <= g.d THEN tp.planned_hours END), 0)::float8 AS ev,
	COALESCE((SELECT SUM(ts.hours) FROM project_timesheet ts
		WHERE ts.project_id = $1 AND ts.tenant_id = $2 AND ts.deleted_at IS NULL AND ts.date::date <= g.d), 0)::float8 AS ac
FROM grid g
LEFT JOIN task_points tp ON tp.d = g.d
GROUP BY g.d
ORDER BY g.d`

// metricsFlow is the live tasks' stage per point, from the same
// intervals (a task covers at most one stage per date).
const metricsFlowSQL = `
WITH grid AS (
	` + metricsGridMain + `
)
SELECT g.d::text AS date, h.stage_id::text AS stage_id, count(*)::int AS n
FROM grid g
JOIN project_task_stage h ON h.project_id = $1 AND h.tenant_id = $2
WHERE h.entered_at::date <= g.d AND (h.left_at IS NULL OR h.left_at::date > g.d)
GROUP BY g.d, h.stage_id
ORDER BY g.d`

// metricsRisk is, per point, each risk's LAST snapshot at or before the
// point (a deleted snapshot drops the risk out; ADR-040's bands:
// criticity ≤ 4 green, ≤ 12 amber, > 12 red).
const metricsRiskSQL = `
WITH grid AS (
	` + metricsGridMain + `
)
SELECT g.d::text AS date, h.criticity::int AS criticity, h.deleted
FROM grid g
JOIN project_risk_history h
	ON h.project_id = $1 AND h.tenant_id = $2
	AND h.recorded_on <= g.d
	AND h.recorded_on = (SELECT max(h2.recorded_on) FROM project_risk_history h2
		WHERE h2.risk_id = h.risk_id AND h2.project_id = $1 AND h2.tenant_id = $2
		AND h2.recorded_on <= g.d)
ORDER BY g.d`

// metricsStages is the project's live stages, ordered for display.
const metricsStagesSQL = `SELECT id::text, name, sequence::int, closed
FROM project_stage
WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
ORDER BY sequence, created_at`

// MetricsPoint is one point of the /metrics series (date YYYY-MM-DD,
// hours as JSON numbers).
type MetricsPoint struct {
	Date           string  `json:"date"`
	ScopeHours     float64 `json:"scope_hours"`
	DoneHours      float64 `json:"done_hours"`
	RemainingHours float64 `json:"remaining_hours"`
	ScopeTasks     int     `json:"scope_tasks"`
	DoneTasks      int     `json:"done_tasks"`
	PV             float64 `json:"pv"`
	EV             float64 `json:"ev"`
	AC             float64 `json:"ac"`
}

type metricsIdealPoint struct {
	Date           string  `json:"date"`
	RemainingHours float64 `json:"remaining_hours"`
}

type metricsStage struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Sequence int    `json:"sequence"`
	Closed   bool   `json:"closed"`
}

type metricsFlowPoint struct {
	Date   string         `json:"date"`
	Counts map[string]int `json:"counts"`
}

type metricsRiskPoint struct {
	Date         string `json:"date"`
	MaxCriticity *int   `json:"max_criticity"`
	SumCriticity int    `json:"sum_criticity"`
	Red          int    `json:"red"`
	Amber        int    `json:"amber"`
	Green        int    `json:"green"`
}

// metricsResponse is the answer of GET /api/v1/project/:id/metrics.
type metricsResponse struct {
	From       string              `json:"from"`
	To         string              `json:"to"`
	Bucket     string              `json:"bucket"`
	Points     []MetricsPoint      `json:"points"`
	Ideal      []metricsIdealPoint `json:"ideal"`
	SPI        *float64            `json:"spi"`
	CPI        *float64            `json:"cpi"`
	PVExcluded int                 `json:"pv_excluded"`
	Stages     []metricsStage      `json:"stages"`
	Flow       []metricsFlowPoint  `json:"flow"`
	Risk       []metricsRiskPoint  `json:"risk"`
}

// Metrics serves GET /api/v1/project/:id/metrics (ADR-041). 404 when the
// project is not visible: an assignee sees the task, not the project's
// numbers.
func (h *Handler) Metrics(c *echo.Context) error {
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
	resp, err := h.projectMetrics(ctx, tenant, id)
	if err != nil {
		return respond(c, err)
	}
	return c.JSON(http.StatusOK, resp)
}

// projectMetrics computes the response. It is tenant-pinned end to end:
// every query takes the caller's tenant as $2.
func (h *Handler) projectMetrics(ctx context.Context, tenant, project uuid.UUID) (*metricsResponse, error) {
	var dateStart, dateEnd, earliest *string
	var today string
	var pvExcluded int
	err := h.db.QueryRow(ctx, metricsWindowSQL, project, tenant).Scan(&dateStart, &dateEnd, &today, &earliest, &pvExcluded)
	if errors.Is(err, orm.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}

	// from = the project's date_start, else the earliest live task's
	// creation, else today.
	fromStr := today
	if earliest != nil {
		fromStr = *earliest
	}
	if dateStart != nil {
		fromStr = *dateStart
	}
	toStr, bucket, gridStart, step, err := metricsWindowDates(today, fromStr, dateEnd)
	if err != nil {
		return nil, err
	}
	// The weekly grid trims at today (today is the last point); the
	// daily one walks the full window (which may end in the future).
	gridEnd := toStr
	if bucket == "week" && today < gridEnd {
		gridEnd = today
	}

	stages, err := h.projectStages(ctx, tenant, project)
	if err != nil {
		return nil, err
	}
	points, err := h.projectPoints(ctx, tenant, project, gridStart, gridEnd, step, fromStr)
	if err != nil {
		return nil, err
	}
	spi, cpi, err := h.projectRatios(ctx, tenant, project, today)
	if err != nil {
		return nil, err
	}
	dateEndStr := ""
	if dateEnd != nil {
		dateEndStr = *dateEnd
	}
	ideal, err := h.projectIdeal(ctx, tenant, project, fromStr, toStr, bucket, today, dateEndStr)
	if err != nil {
		return nil, err
	}
	flow, err := h.projectFlow(ctx, tenant, project, gridStart, gridEnd, step, fromStr, stages, points)
	if err != nil {
		return nil, err
	}
	risk, err := h.projectRisk(ctx, tenant, project, gridStart, gridEnd, step, fromStr, points)
	if err != nil {
		return nil, err
	}

	return &metricsResponse{
		From:       fromStr,
		To:         toStr,
		Bucket:     bucket,
		Points:     points,
		Ideal:      ideal,
		SPI:        spi,
		CPI:        cpi,
		PVExcluded: pvExcluded,
		Stages:     stages,
		Flow:       flow,
		Risk:       risk,
	}, nil
}

// metricsWindowDates is the window arithmetic (kept pure so it is unit
// testable without a database): to = max(today, date_end) capped at
// from + 3 years (and at least from); the bucket is day within 120
// days, else week — the week grid starts on the first Monday at or
// after from.
func metricsWindowDates(today, from string, dateEnd *string) (to, bucket, gridStart, step string, err error) {
	to = today
	if dateEnd != nil && *dateEnd > today {
		to = *dateEnd
	}
	fromT, err := time.Parse(metricsDateLayout, from)
	if err != nil {
		return "", "", "", "", err
	}
	if cap := fromT.AddDate(3, 0, 0).Format(metricsDateLayout); to > cap {
		to = cap
	}
	if to < from {
		to = from
	}
	toT, err := time.Parse(metricsDateLayout, to)
	if err != nil {
		return "", "", "", "", err
	}
	bucket, step, gridStart = "week", "7 days", firstMonday(fromT).Format(metricsDateLayout)
	if toT.Sub(fromT).Hours()/24 <= 120 {
		bucket, step, gridStart = "day", "1 day", from
	}
	return to, bucket, gridStart, step, nil
}

// firstMonday is the first Monday at or after d (0..6 days ahead).
func firstMonday(d time.Time) time.Time {
	return d.AddDate(0, 0, (1-int(d.Weekday())+7)%7)
}

func (h *Handler) projectStages(ctx context.Context, tenant, project uuid.UUID) ([]metricsStage, error) {
	rows, err := h.db.Query(ctx, metricsStagesSQL, project, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	stages := []metricsStage{}
	for rows.Next() {
		var s metricsStage
		if err := rows.Scan(&s.ID, &s.Name, &s.Sequence, &s.Closed); err != nil {
			return nil, err
		}
		stages = append(stages, s)
	}
	return stages, rows.Err()
}

// series runs the point aggregate over one grid: the main grid
// (generate_series + today) or a single date.
func (h *Handler) series(ctx context.Context, tenant, project uuid.UUID, grid string, dates ...string) ([]MetricsPoint, error) {
	args := make([]any, 0, len(dates)+2)
	args = append(args, project, tenant)
	for _, d := range dates {
		args = append(args, d)
	}
	rows, err := h.db.Query(ctx, fmt.Sprintf(metricsSeriesBody, grid), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	points := []MetricsPoint{}
	for rows.Next() {
		var p MetricsPoint
		if err := rows.Scan(&p.Date, &p.ScopeHours, &p.ScopeTasks, &p.DoneHours, &p.DoneTasks, &p.PV, &p.EV, &p.AC); err != nil {
			return nil, err
		}
		p.RemainingHours = p.ScopeHours - p.DoneHours
		points = append(points, p)
	}
	return points, rows.Err()
}

// projectPoints runs the main series over the window's grid.
func (h *Handler) projectPoints(ctx context.Context, tenant, project uuid.UUID, gridStart, gridEnd, step, windowFrom string) ([]MetricsPoint, error) {
	return h.series(ctx, tenant, project, metricsGridMain, gridStart, gridEnd, step, windowFrom)
}

// projectRatios is spi/cpi at today (spi = ev/pv, cpi = ev/ac; null when
// the denominator is 0).
func (h *Handler) projectRatios(ctx context.Context, tenant, project uuid.UUID, today string) (*float64, *float64, error) {
	points, err := h.series(ctx, tenant, project, metricsGridSingle, today)
	if err != nil {
		return nil, nil, err
	}
	if len(points) != 1 {
		return nil, nil, fmt.Errorf("project: metrics: today series returned %d points, want 1", len(points))
	}
	var spi, cpi *float64
	if points[0].PV > 0 {
		v := points[0].EV / points[0].PV
		spi = &v
	}
	if points[0].AC > 0 {
		v := points[0].EV / points[0].AC
		cpi = &v
	}
	return spi, cpi, nil
}

// projectIdeal is the ideal burndown line: from scope(from) at from down
// to 0 at date_end, over the bucket's grid plus the two anchors and
// today (when it is in the line's range). None when date_end is absent
// or before from; clipped at the window's to.
func (h *Handler) projectIdeal(ctx context.Context, tenant, project uuid.UUID, from, to, bucket, today, dateEnd string) ([]metricsIdealPoint, error) {
	ideal := []metricsIdealPoint{}
	if dateEnd == "" || dateEnd < from {
		return ideal, nil
	}
	fromT, err := time.Parse(metricsDateLayout, from)
	if err != nil {
		return nil, err
	}
	endT, err := time.Parse(metricsDateLayout, dateEnd)
	if err != nil {
		return nil, err
	}
	toT, err := time.Parse(metricsDateLayout, to)
	if err != nil {
		return nil, err
	}
	if endT.After(toT) {
		endT = toT
	}
	todayT, err := time.Parse(metricsDateLayout, today)
	if err != nil {
		return nil, err
	}
	points, err := h.series(ctx, tenant, project, metricsGridSingle, from)
	if err != nil {
		return nil, err
	}
	if len(points) != 1 {
		return nil, fmt.Errorf("project: metrics: from series returned %d points, want 1", len(points))
	}
	scopeFrom := points[0].ScopeHours

	total := endT.Sub(fromT).Hours() / 24
	dates := make([]time.Time, 0, len(idealDates(fromT, endT, todayT, bucket)))
	for d := range idealDates(fromT, endT, todayT, bucket) {
		dates = append(dates, d)
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
	for _, d := range dates {
		remaining := 0.0
		if total > 0 {
			remaining = scopeFrom * (endT.Sub(d).Hours() / 24) / total
		}
		ideal = append(ideal, metricsIdealPoint{Date: d.Format(metricsDateLayout), RemainingHours: remaining})
	}
	return ideal, nil
}

// idealDates is the ideal line's dates: the bucket's grid within
// [from, end] plus from itself and today (when today is in (from, end]
// and not already a grid point).
func idealDates(from, end, today time.Time, bucket string) map[time.Time]bool {
	dates := map[time.Time]bool{from: true}
	d, step := from, 1
	if bucket == "week" {
		d, step = firstMonday(from), 7
	}
	for !d.After(end) {
		dates[d] = true
		d = d.AddDate(0, 0, step)
	}
	if today.After(from) && !today.After(end) {
		dates[today] = true
	}
	return dates
}

// projectFlow aligns the per-stage counts with the points (same grid).
func (h *Handler) projectFlow(ctx context.Context, tenant, project uuid.UUID, gridStart, gridEnd, step, windowFrom string, stages []metricsStage, points []MetricsPoint) ([]metricsFlowPoint, error) {
	rows, err := h.db.Query(ctx, metricsFlowSQL, project, tenant, gridStart, gridEnd, step, windowFrom)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	perDate := map[string]map[string]int{}
	for rows.Next() {
		var date, stage string
		var n int
		if err := rows.Scan(&date, &stage, &n); err != nil {
			return nil, err
		}
		m := perDate[date]
		if m == nil {
			m = map[string]int{}
			perDate[date] = m
		}
		m[stage] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]metricsFlowPoint, 0, len(points))
	for _, p := range points {
		counts := map[string]int{}
		for _, s := range stages {
			counts[s.ID] = 0
		}
		for id, n := range perDate[p.Date] {
			counts[id] = n
		}
		out = append(out, metricsFlowPoint{Date: p.Date, Counts: counts})
	}
	return out, nil
}

// projectRisk aligns the per-date risk aggregates with the points (same
// grid); a date with no live risk is zeros with max_criticity null.
func (h *Handler) projectRisk(ctx context.Context, tenant, project uuid.UUID, gridStart, gridEnd, step, windowFrom string, points []MetricsPoint) ([]metricsRiskPoint, error) {
	rows, err := h.db.Query(ctx, metricsRiskSQL, project, tenant, gridStart, gridEnd, step, windowFrom)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type agg struct {
		max   int
		sum   int
		red   int
		amber int
		green int
	}
	perDate := map[string]*agg{}
	for rows.Next() {
		var date string
		var criticity *int
		var deleted bool
		if err := rows.Scan(&date, &criticity, &deleted); err != nil {
			return nil, err
		}
		if deleted || criticity == nil {
			continue
		}
		a := perDate[date]
		if a == nil {
			a = &agg{}
			perDate[date] = a
		}
		if *criticity > a.max {
			a.max = *criticity
		}
		a.sum += *criticity
		switch {
		case *criticity <= 4:
			a.green++
		case *criticity <= 12:
			a.amber++
		default:
			a.red++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]metricsRiskPoint, 0, len(points))
	for _, p := range points {
		a := perDate[p.Date]
		if a == nil {
			out = append(out, metricsRiskPoint{Date: p.Date})
			continue
		}
		max := a.max
		out = append(out, metricsRiskPoint{Date: p.Date, MaxCriticity: &max, SumCriticity: a.sum, Red: a.red, Amber: a.amber, Green: a.green})
	}
	return out, nil
}
