package project

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// baselineLimit is the maximum number of live baselines of one project.
const baselineLimit = 20

// CreateBaseline handles POST /api/v1/project/:id/baseline {name} → 201 with
// the baseline: the manager or an admin snapshots the project's live tasks
// (their start, deadline and planned hours) into project_baseline_task, in
// one transaction. 404 when the project isn't visible, 403 for the others,
// 409 BASELINE_LIMIT past baselineLimit live baselines.
func (h *Handler) CreateBaseline(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	who, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return errNoCaller
	}
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
	can, err := h.manages(ctx, tenant, who.UserID, id)
	if err != nil {
		return err
	}
	if !can {
		return respond(c, errForbidden)
	}
	var body struct{ Name string }
	if err := json.NewDecoder(c.Request().Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		return respond(c, invalid("name", "name is required"))
	}
	name := strings.TrimSpace(body.Name)
	if utf8.RuneCountInString(name) > 200 {
		return respond(c, invalid("name", "name is longer than 200 characters"))
	}
	var created uuid.UUID
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		// Lock the project row: serializes the limit check against
		// concurrent creates (a first baseline has no rows to lock).
		var locked bool
		if err := tx.QueryRow(ctx, `SELECT true FROM project WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, id, tenant).Scan(&locked); err != nil {
			return err
		}
		if !locked {
			return errNotFound
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM project_baseline
			WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant).Scan(&n); err != nil {
			return err
		}
		if n >= baselineLimit {
			return &rejection{status: http.StatusConflict, code: "BASELINE_LIMIT",
				msg: "the project already has " + strconv.Itoa(baselineLimit) + " baselines: delete one first"}
		}
		if err := tx.QueryRow(ctx, `INSERT INTO project_baseline (tenant_id, project_id, name, created_by)
			VALUES ($1, $2, $3, $4) RETURNING id`, tenant, id, name, who.UserID).Scan(&created); err != nil {
			return err
		}
		// The snapshot: every live task's dates and planned hours.
		_, err := tx.Exec(ctx, `INSERT INTO project_baseline_task
			(tenant_id, baseline_id, project_id, task_id, date_start, deadline, planned_hours)
			SELECT $1, $2, project_id, id, date_start, deadline, planned_hours FROM project_task
			WHERE project_id = $3 AND tenant_id = $1 AND deleted_at IS NULL`, tenant, created, id)
		return err
	})
	if err != nil {
		return respond(c, err)
	}
	row, err := h.row(ctx, "project_baseline", created, tenant, true)
	if err != nil {
		return respond(c, err)
	}
	return c.JSON(http.StatusCreated, row)
}

// DeleteBaseline handles DELETE /api/v1/project_baseline/:id behind
// ValidateBaselineBody (visible, manager or admin): the baseline and its
// task rows are soft-deleted in one transaction; the rows share the
// baseline's deleted_at (the DeleteColor shape), so a restore brings them
// back with it.
func (h *Handler) DeleteBaseline(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE project_baseline SET deleted_at = now(), updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		// now() is the transaction's start: the rows share the baseline's deleted_at.
		_, err = tx.Exec(ctx, `UPDATE project_baseline_task SET deleted_at = now(), updated_at = now()
			WHERE baseline_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
		return err
	})
	if err != nil {
		return respond(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// RestoreBaseline handles POST /api/v1/project_baseline/:id/restore behind
// ValidateBaselineBody (manager or admin): the baseline and the task rows
// DeleteBaseline deleted with it (same deleted_at) come back in one
// transaction; the answer is the baseline.
func (h *Handler) RestoreBaseline(get echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
		}
		err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
			var at time.Time
			if err := tx.QueryRow(ctx, `UPDATE project_baseline p SET deleted_at = NULL, updated_at = now()
				FROM (SELECT deleted_at FROM project_baseline WHERE id = $1 AND tenant_id = $2 FOR UPDATE) old
				WHERE p.id = $1 AND p.tenant_id = $2 AND p.deleted_at IS NOT NULL RETURNING old.deleted_at`,
				id, tenant).Scan(&at); err != nil {
				if errors.Is(err, orm.ErrNotFound) {
					return errNotFound
				}
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE project_baseline_task SET deleted_at = NULL, updated_at = now()
				WHERE baseline_id = $1 AND tenant_id = $2 AND deleted_at = $3`, id, tenant, at)
			return err
		})
		if err != nil {
			return respond(c, err)
		}
		return get(c)
	}
}
