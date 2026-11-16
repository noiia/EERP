package project

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// recomputeRisks rewrites severity_computed/severity_note of the live risks of
// the given projects (all tenant projects with live risks when projects is
// empty), only where a value changed. It reads unscoped and writes only those
// two derived columns, so it is safe to run for any caller.
func recomputeRisks(ctx context.Context, ex orm.Executor, tenant uuid.UUID, projects ...uuid.UUID) error {
	if len(projects) == 0 {
		rows, err := ex.Query(ctx, `SELECT DISTINCT project_id FROM project_risk WHERE tenant_id = $1 AND deleted_at IS NULL`, tenant)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			projects = append(projects, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	for _, p := range projects {
		if err := recomputeProject(ctx, ex, tenant, p); err != nil {
			return err
		}
	}
	return nil
}

func recomputeProject(ctx context.Context, ex orm.Executor, tenant, project uuid.UUID) error {
	var planned float64
	if err := ex.QueryRow(ctx, `SELECT planned_hours FROM project WHERE id = $1 AND tenant_id = $2`, project, tenant).Scan(&planned); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return nil
		}
		return err
	}
	var tasks []calcTask
	rows, err := ex.Query(ctx, `SELECT id, planned_hours, date_start, deadline, closed FROM project_task
		WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, project, tenant)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t calcTask
		var ds, dl *time.Time
		if err := rows.Scan(&t.ID, &t.PlannedHours, &ds, &dl, &t.Closed); err != nil {
			rows.Close()
			return err
		}
		t.DateStart, t.Deadline = ds, dl
		tasks = append(tasks, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	var links []calcLink
	rows, err = ex.Query(ctx, `SELECT d.depends_on_id, d.task_id FROM project_task_dependency d
		JOIN project_task a ON a.id = d.task_id AND a.deleted_at IS NULL
		JOIN project_task b ON b.id = d.depends_on_id AND b.deleted_at IS NULL
		WHERE d.project_id = $1 AND d.tenant_id = $2 AND d.deleted_at IS NULL`, project, tenant)
	if err != nil {
		return err
	}
	for rows.Next() {
		var l calcLink
		if err := rows.Scan(&l.From, &l.To); err != nil {
			rows.Close()
			return err
		}
		links = append(links, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	byRisk := map[uuid.UUID][]ProjectRiskTask{}
	rows, err = ex.Query(ctx, `SELECT l.risk_id, l.task_id, l.delay_days, l.extra_hours FROM project_risk_task l
		JOIN project_task t ON t.id = l.task_id AND t.deleted_at IS NULL
		WHERE l.project_id = $1 AND l.tenant_id = $2 AND l.deleted_at IS NULL`, project, tenant)
	if err != nil {
		return err
	}
	for rows.Next() {
		var l ProjectRiskTask
		if err := rows.Scan(&l.RiskID, &l.TaskID, &l.DelayDays, &l.ExtraHours); err != nil {
			rows.Close()
			return err
		}
		byRisk[l.RiskID] = append(byRisk[l.RiskID], l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	type risk struct {
		id     uuid.UUID
		impact string
	}
	var risks []risk
	rows, err = ex.Query(ctx, `SELECT id, impact_on FROM project_risk WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, project, tenant)
	if err != nil {
		return err
	}
	for rows.Next() {
		var r risk
		if err := rows.Scan(&r.id, &r.impact); err != nil {
			rows.Close()
			return err
		}
		risks = append(risks, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, r := range risks {
		sev, note := riskSeverity(r.impact, tasks, links, planned, byRisk[r.id])
		var n *string
		if note != "" {
			n = &note
		}
		if _, err := ex.Exec(ctx, `UPDATE project_risk SET severity_computed = $1, severity_note = $2, updated_at = now()
			WHERE id = $3 AND (severity_computed IS DISTINCT FROM $1 OR severity_note IS DISTINCT FROM $2)`, sev, n, r.id); err != nil {
			return err
		}
	}
	return nil
}

// RecomputeOnRead refreshes the derived severity of the risks a GET is about
// to read: the project of filter[project_id], the stored risk's project on
// /:id, every project of the tenant when the list is unpinned. The read itself
// stays the generic handler's, row scope included.
func (h *Handler) RecomputeOnRead(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		var projects []uuid.UUID
		if raw := c.Param("id"); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil {
				return next(c) // the generic handler answers 400
			}
			p, ok, err := h.projectOf(ctx, "project_risk", tenant, id)
			if err != nil {
				return err
			}
			if !ok {
				return next(c)
			}
			projects = []uuid.UUID{p}
		} else if raw := c.QueryParam("filter[project_id]"); raw != "" {
			p, err := uuid.Parse(raw)
			if err != nil {
				return next(c)
			}
			projects = []uuid.UUID{p}
		}
		// shortcut: an unpinned list recomputes every project with live risks in the tenant, upgrade to a dirty flag or background job when tenants hold thousands of risky projects.
		if err := recomputeRisks(ctx, h.db, tenant, projects...); err != nil {
			return err
		}
		return next(c)
	}
}

// projectOf is the project of a stored row, deleted or not.
func (h *Handler) projectOf(ctx context.Context, table string, tenant, id uuid.UUID) (uuid.UUID, bool, error) {
	var p uuid.UUID
	err := h.db.QueryRow(ctx, `SELECT project_id FROM `+table+` WHERE id = $1 AND tenant_id = $2`, id, tenant).Scan(&p)
	if errors.Is(err, orm.ErrNotFound) {
		return uuid.Nil, false, nil
	}
	return p, err == nil, err
}

// bufferedResponse holds the status and body of a response until it is known
// whether it must be patched; headers go straight to the real writer.
type bufferedResponse struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (b *bufferedResponse) WriteHeader(code int) {
	if b.status == 0 {
		b.status = code
	}
}

func (b *bufferedResponse) Write(p []byte) (int, error) {
	b.WriteHeader(http.StatusOK)
	return b.body.Write(p)
}

// RecomputeAfterWrite wraps a project_risk or project_risk_task write handler
// (it must sit AFTER the guard, which rewrites the body): once the write
// succeeded, the project's risks are recomputed, and a risk's own POST/PUT
// answer carries the fresh derived columns. The write's response is held in a
// buffer meanwhile; any other answer is flushed unchanged.
func (h *Handler) RecomputeAfterWrite(table string, next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		var project uuid.UUID
		var known bool
		if raw := c.Param("id"); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil {
				return next(c)
			}
			if project, known, err = h.projectOf(ctx, table, tenant, id); err != nil {
				return err
			}
		} else {
			raw, err := io.ReadAll(c.Request().Body)
			if err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
			}
			c.Request().Body = io.NopCloser(bytes.NewReader(raw))
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			if table == "project_risk" {
				project, _ = uuid.Parse(asString(body["project_id"]))
				known = project != uuid.Nil
			} else if risk, err := uuid.Parse(asString(body["risk_id"])); err == nil {
				if project, known, err = h.projectOf(ctx, "project_risk", tenant, risk); err != nil {
					return err
				}
			}
		}

		orig := c.Response()
		buf := &bufferedResponse{ResponseWriter: orig}
		c.SetResponse(buf)
		err := next(c)
		c.SetResponse(orig)
		if err != nil {
			return err
		}
		out := buf.body.Bytes()
		if buf.status >= 200 && buf.status < 300 && known {
			if err := recomputeRisks(ctx, h.db, tenant, project); err != nil {
				return err
			}
			if table == "project_risk" && buf.status != http.StatusNoContent {
				if patched, ok := h.freshRisk(ctx, tenant, out); ok {
					out = patched
				}
			}
		}
		if buf.status != 0 {
			orig.WriteHeader(buf.status)
		}
		_, err = orig.Write(out)
		return err
	}
}

// freshRisk overwrites the derived columns of a written risk's JSON answer
// with their stored values.
func (h *Handler) freshRisk(ctx context.Context, tenant uuid.UUID, out []byte) ([]byte, bool) {
	var body map[string]any
	if json.Unmarshal(out, &body) != nil {
		return nil, false
	}
	id, err := uuid.Parse(asString(body["id"]))
	if err != nil {
		return nil, false
	}
	var comp, eff, crit *int
	var note *string
	if h.db.QueryRow(ctx, `SELECT severity_computed, severity_note, severity_effective, criticity FROM project_risk
		WHERE id = $1 AND tenant_id = $2`, id, tenant).Scan(&comp, &note, &eff, &crit) != nil {
		return nil, false
	}
	body["severity_computed"], body["severity_note"], body["severity_effective"], body["criticity"] = comp, note, eff, crit
	patched, err := json.Marshal(body)
	return patched, err == nil
}
