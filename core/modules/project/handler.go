package project

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Handler holds the Project app's write overrides and validation middlewares.
type Handler struct {
	db    *orm.DB
	perms *auth.PermissionRepository
}

// NewHandler builds the handler; perms decides who is a project admin.
func NewHandler(db *orm.DB, perms *auth.PermissionRepository) *Handler {
	return &Handler{db: db, perms: perms}
}

// Generic is the generic CRUD handler of one table (ormserver.BuildHandlers).
type Generic interface {
	List(*echo.Context) error
	Create(*echo.Context) error
	Update(*echo.Context) error
	Delete(*echo.Context) error
	Restore(*echo.Context) error
	GetByID(*echo.Context) error
}

// Mount puts the validation middlewares and overrides in front of the
// project tables' generic writes. Call it AFTER RegisterRoutes so Echo keeps
// these registrations; mw are the group's (JWT, permission, active gate).
func (h *Handler) Mount(e *echo.Echo, generic func(table string) Generic, mw ...echo.MiddlewareFunc) {
	guards := map[string]echo.MiddlewareFunc{
		"project":                 h.ValidateProjectBody,
		"project_member":          h.ValidateMemberBody,
		"project_stage":           h.ValidateStageBody,
		"project_task":            h.ValidateTaskBody,
		"project_milestone":       h.ValidateMilestoneBody,
		"project_task_dependency": h.ValidateDependencyBody,
		"project_task_user":       h.ValidateTaskLinkBody("project_task_user"),
		"project_task_tag":        h.ValidateTaskLinkBody("project_task_tag"),
		"project_color":           h.ValidateColorBody,
		"project_task_color":      h.ValidateTaskLinkBody("project_task_color"),
		"project_timesheet":       h.ValidateTimesheetBody,
		"project_obs_box":         h.ValidateObsBody,
	}
	for table, guard := range guards {
		g := generic(table)
		with := append(append([]echo.MiddlewareFunc{}, mw...), guard)
		update, del, restore := g.Update, g.Delete, g.Restore
		switch table {
		case "project":
			del, restore = h.DeleteProject, h.RestoreProject(g.GetByID)
		case "project_stage":
			del = h.DeleteStage
		case "project_obs_box":
			del = h.DeleteObsBox
		case "project_color":
			del, restore = h.DeleteColor, h.RestoreColor(g.GetByID)
		case "project_task":
			update = h.UpdateTask(g.Update, g.GetByID)
		}
		base := "/api/v1/" + table
		e.POST(base, g.Create, with...)
		e.PUT(base+"/:id", update, with...)
		e.DELETE(base+"/:id", del, with...)
		e.POST(base+"/:id/restore", restore, with...)
	}
	e.GET("/api/v1/project_task", AssignedToMe(TaskFilters(generic("project_task").List)), mw...)
	e.GET("/api/v1/project/:id/can_manage", h.CanManage, mw...)
}

// AssignedToMe serves the task list's filter[assignee]=me (the My tasks
// page): assignees live in project_task_user, not on the task row, so the
// param is taken off the query and TaskScope narrows to the caller's own
// assignments. Any other value stays, and the generic list refuses it (400).
func AssignedToMe(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		if q := c.QueryParams(); q.Get(assigneeParam) == "me" {
			q.Del(assigneeParam) // QueryParams is the context's cached map
			r := c.Request()
			c.SetRequest(r.WithContext(context.WithValue(r.Context(), assignedOnlyKey{}, true)))
		}
		return next(c)
	}
}

// TaskFilters serves the task list's many2many filters (taskLinkFilters):
// the generic list knows only columns, so each is taken off the query and
// TaskScope applies it. A value that isn't an id is a 400.
func TaskFilters(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		q := c.QueryParams() // the context's cached map
		var links []linkFilter
		for _, f := range taskLinkFilters {
			v := q.Get(f.param)
			if v == "" {
				continue
			}
			id, err := uuid.Parse(v)
			if err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, f.param+" must be an id")
			}
			q.Del(f.param)
			links = append(links, linkFilter{f.table, f.column, id})
		}
		if len(links) > 0 {
			r := c.Request()
			c.SetRequest(r.WithContext(context.WithValue(r.Context(), linkFiltersKey{}, links)))
		}
		return next(c)
	}
}

// conflict is a refused delete.
func conflict(msg string) error {
	return &rejection{status: http.StatusConflict, code: "CONFLICT", msg: msg}
}

// DeleteProject handles DELETE /api/v1/project/:id behind ValidateProjectBody
// (visible, manager or admin): refused while the project has live tasks,
// else the project, its stages, milestones and members are soft-deleted in
// one transaction. The guard reads task_count, which the task triggers keep
// under the project's row lock, so a task created concurrently is seen.
func (h *Handler) DeleteProject(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE project SET deleted_at = now(), updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND task_count = 0`, id, tenant)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return conflict("the project still has tasks: delete them first, or archive the project")
		}
		for _, table := range []string{"project_stage", "project_milestone", "project_member", "project_obs_box"} {
			if _, err := tx.Exec(ctx, `UPDATE `+table+` SET deleted_at = now(), updated_at = now()
				WHERE project_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return respond(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// RestoreProject handles POST /api/v1/project/:id/restore behind
// ValidateProjectBody (seen when deleted, manager or admin): the project and
// the stages, milestones and members DeleteProject deleted with it (same
// deleted_at) come back in one transaction; the answer is the project.
func (h *Handler) RestoreProject(get echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
		}
		err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
			var at time.Time
			if err := tx.QueryRow(ctx, `UPDATE project p SET deleted_at = NULL, updated_at = now()
				FROM (SELECT deleted_at FROM project WHERE id = $1 AND tenant_id = $2 FOR UPDATE) old
				WHERE p.id = $1 AND p.tenant_id = $2 AND p.deleted_at IS NOT NULL RETURNING old.deleted_at`,
				id, tenant).Scan(&at); err != nil {
				if errors.Is(err, orm.ErrNotFound) {
					return errNotFound
				}
				return err
			}
			for _, table := range []string{"project_stage", "project_milestone", "project_member", "project_obs_box"} {
				if _, err := tx.Exec(ctx, `UPDATE `+table+` SET deleted_at = NULL, updated_at = now()
					WHERE project_id = $1 AND tenant_id = $2 AND deleted_at = $3`, id, tenant, at); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return respond(c, err)
		}
		return get(c)
	}
}

// DeleteColor handles DELETE /api/v1/project_color/:id behind
// ValidateColorBody (any writer: color groups have no manager): the color and
// its live task links are soft-deleted in one transaction, so no task keeps
// a link to a deleted group.
func (h *Handler) DeleteColor(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE project_color SET deleted_at = now(), updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		// now() is the transaction's start: the links share the color's deleted_at.
		_, err = tx.Exec(ctx, `UPDATE project_task_color SET deleted_at = now(), updated_at = now()
			WHERE color_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
		return err
	})
	if err != nil {
		return respond(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// RestoreColor handles POST /api/v1/project_color/:id/restore behind
// ValidateColorBody: the color and the links DeleteColor deleted with it
// (same deleted_at) come back in one transaction; the answer is the color.
func (h *Handler) RestoreColor(get echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
		}
		err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
			var at time.Time
			if err := tx.QueryRow(ctx, `UPDATE project_color p SET deleted_at = NULL, updated_at = now()
				FROM (SELECT deleted_at FROM project_color WHERE id = $1 AND tenant_id = $2 FOR UPDATE) old
				WHERE p.id = $1 AND p.tenant_id = $2 AND p.deleted_at IS NOT NULL RETURNING old.deleted_at`,
				id, tenant).Scan(&at); err != nil {
				if errors.Is(err, orm.ErrNotFound) {
					return errNotFound
				}
				return err
			}
			_, err := tx.Exec(ctx, `UPDATE project_task_color SET deleted_at = NULL, updated_at = now()
				WHERE color_id = $1 AND tenant_id = $2 AND deleted_at = $3`, id, tenant, at)
			return err
		})
		if err != nil {
			return respond(c, err)
		}
		return get(c)
	}
}

// DeleteStage handles DELETE /api/v1/project_stage/:id behind
// ValidateStageBody: refused while live tasks sit in the stage.
func (h *Handler) DeleteStage(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	tag, err := h.db.Exec(ctx, `UPDATE project_stage SET deleted_at = now(), updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM project_task WHERE stage_id = $1 AND deleted_at IS NULL)`, id, tenant)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return respond(c, conflict("the stage still has tasks: move them to another stage first"))
	}
	return c.NoContent(http.StatusNoContent)
}

// DeleteObsBox handles DELETE /api/v1/project_obs_box/:id behind
// ValidateObsBody (visible, manager or admin): its live children lose their
// parent and the box is soft-deleted, in one transaction.
func (h *Handler) DeleteObsBox(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant, _ := access.TenantFromContext(ctx)
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE project_obs_box SET parent_id = NULL, updated_at = now()
			WHERE parent_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE project_obs_box SET deleted_at = now(), updated_at = now()
			WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, id, tenant)
		if err == nil && tag.RowsAffected() == 0 {
			return errNotFound
		}
		return err
	})
	if err != nil {
		return respond(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// moveColumns are set by a move itself, never by the update that follows.
var moveColumns = []string{"project_id", "stage_id", "milestone_id", "parent_id"}

// UpdateTask handles PUT /api/v1/project_task/:id behind ValidateTaskBody
// (which refused a subtask and an invisible target). Without a project
// change it is the generic update. With one, the task and its descendants
// move in one transaction: each one's stage becomes the target's stage of
// the same name (else its first stage), its milestone is cleared, and the
// rows hanging off the moved tasks follow. Dependencies keep their other
// end (they may cross projects). The body's other fields then go through
// the generic update; the answer is the stored task.
func (h *Handler) UpdateTask(update, get echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		tenant, _ := access.TenantFromContext(ctx)
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
		}
		raw, err := io.ReadAll(c.Request().Body)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
		}
		var body map[string]any
		_ = json.Unmarshal(raw, &body) // the guard already parsed it
		target, _ := uuid.Parse(asString(body["project_id"]))
		var current uuid.UUID
		err = h.db.QueryRow(ctx, `SELECT project_id FROM project_task WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
			id, tenant).Scan(&current)
		if errors.Is(err, orm.ErrNotFound) {
			return respond(c, errNotFound)
		}
		if err != nil {
			return err
		}
		if target == uuid.Nil || target == current {
			c.Request().Body = io.NopCloser(bytes.NewReader(raw))
			return update(c)
		}
		if err := orm.Transact(ctx, h.db, func(tx *orm.Tx) error { return moveTask(c, tx, tenant, id, target) }); err != nil {
			return err
		}
		for _, k := range moveColumns {
			delete(body, k)
		}
		if len(body) == 0 {
			return get(c)
		}
		raw, _ = json.Marshal(body)
		c.Request().Body = io.NopCloser(bytes.NewReader(raw))
		return update(c)
	}
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// moveTask moves task (a top-level task) and its whole subtree to target.
func moveTask(c *echo.Context, tx *orm.Tx, tenant, task, target uuid.UUID) error {
	ctx := c.Request().Context()
	const tree = `WITH RECURSIVE tree AS (
		SELECT id FROM project_task WHERE id = $1 AND tenant_id = $2
		UNION SELECT t.id FROM project_task t JOIN tree ON t.parent_id = tree.id WHERE t.tenant_id = $2)`
	if _, err := tx.Exec(ctx, tree+`
		UPDATE project_task t SET project_id = $3, milestone_id = NULL, updated_at = now(),
			parent_id = CASE WHEN t.id = $1 THEN NULL ELSE t.parent_id END,
			stage_id = COALESCE(
				(SELECT s.id FROM project_stage s JOIN project_stage old ON old.id = t.stage_id
					WHERE s.project_id = $3 AND s.deleted_at IS NULL AND s.name = old.name ORDER BY s.sequence LIMIT 1),
				(SELECT s.id FROM project_stage s WHERE s.project_id = $3 AND s.deleted_at IS NULL
					ORDER BY s.sequence, s.created_at LIMIT 1))
		WHERE t.id IN (SELECT id FROM tree)`, task, tenant, target); err != nil {
		return err
	}
	for _, table := range []string{"project_timesheet", "project_task_user", "project_task_tag", "project_task_color", "project_task_dependency"} {
		if _, err := tx.Exec(ctx, tree+`
			UPDATE `+table+` SET project_id = $3, updated_at = now()
			WHERE tenant_id = $2 AND task_id IN (SELECT id FROM tree)`, task, tenant, target); err != nil {
			return err
		}
	}
	return nil
}

// CanManage handles GET /api/v1/project/:id/can_manage → {"can_manage":
// bool}: whether the caller may edit the project, its members and stages
// (the kanban's column controls). 404 when the project isn't visible.
func (h *Handler) CanManage(c *echo.Context) error {
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
	return c.JSON(http.StatusOK, map[string]bool{"can_manage": can})
}
