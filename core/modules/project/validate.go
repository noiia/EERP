package project

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"core/internal/auth"
	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// The write invariants of the Project app, in front of the generic CRUD
// writes: every reference must be visible to the caller and inside the
// record's project, denormalized project_id columns are set from the parent
// task, manager-only writes are refused to others, and POSTs get defaults
// for the columns the generic create would otherwise require.

// rejection is a refused write, answered as {"error": {code, message, …}}.
type rejection struct {
	status int
	code   string
	msg    string
	fields []string
}

func (e *rejection) Error() string { return e.msg }

func invalid(field, msg string) error {
	return &rejection{http.StatusUnprocessableEntity, "VALIDATION_ERROR", msg, []string{field}}
}

var (
	errNotFound  = &rejection{status: http.StatusNotFound, code: "NOT_FOUND", msg: "not found"}
	errForbidden = &rejection{status: http.StatusForbidden, code: "FORBIDDEN", msg: "only the project's manager or a project admin can do this"}
)

// respond writes a rejection as JSON; any other error goes to Echo's handler.
func respond(c *echo.Context, err error) error {
	var r *rejection
	if !errors.As(err, &r) {
		return err
	}
	body := map[string]any{"code": r.code, "message": r.msg, "request_id": c.Response().Header().Get(echo.HeaderXRequestID)}
	if r.fields != nil {
		body["fields"] = r.fields
	}
	return c.JSON(r.status, map[string]any{"error": body})
}

type op int

const (
	opCreate op = iota // POST, and restore (re-checked as if created again)
	opUpdate
	opDelete
)

// request is one write under validation. body is what the generic handler
// will bind (the stored row on a restore); stored is the live row (nil on a
// create).
type request struct {
	h      *Handler
	ctx    context.Context
	op     op
	tenant uuid.UUID
	user   uuid.UUID
	id     uuid.UUID
	body   map[string]any
	stored map[string]any
}

// get is the value after the write: the body's, else the stored one.
func (r *request) get(k string) any {
	if v, ok := r.body[k]; ok {
		return v
	}
	return r.stored[k]
}

// changed: the write sets k to something other than what is stored.
func (r *request) changed(k string) bool {
	v, ok := r.body[k]
	if !ok {
		return false
	}
	if r.stored == nil {
		return v != nil
	}
	return !same(v, r.stored[k])
}

func same(a, b any) bool {
	as, aok := a.(string)
	bs, bok := b.(string)
	if aok && bok {
		ai, aerr := uuid.Parse(as)
		bi, berr := uuid.Parse(bs)
		if aerr == nil && berr == nil {
			return ai == bi
		}
	}
	return reflect.DeepEqual(a, b)
}

// ref parses the id in k after the write (uuid.Nil when null).
func (r *request) ref(k string) (uuid.UUID, error) {
	switch v := r.get(k).(type) {
	case nil:
		return uuid.Nil, nil
	case string:
		if id, err := uuid.Parse(v); err == nil {
			return id, nil
		}
	}
	return uuid.Nil, invalid(k, k+" must be an id")
}

// visibleRef is ref, checked visible (orm.CanSeeRecord: tenant and row scope)
// when the write changes it; required refuses a null.
func (r *request) visibleRef(table, k string, required bool) (uuid.UUID, error) {
	id, err := r.ref(k)
	if err != nil {
		return id, err
	}
	if id == uuid.Nil {
		if required {
			return id, invalid(k, k+" is required")
		}
		return id, nil
	}
	if r.changed(k) {
		ok, err := orm.CanSeeRecord(r.ctx, r.h.db, table, id)
		if err != nil {
			return id, err
		}
		if !ok {
			return id, invalid(k, k+" not found")
		}
	}
	return id, nil
}

// inProject checks an optional ref to a row of table that must belong to
// project pid.
func (r *request) inProject(table, k string, pid uuid.UUID) (uuid.UUID, error) {
	id, err := r.visibleRef(table, k, false)
	if err != nil || id == uuid.Nil || !(r.changed(k) || r.changed("project_id")) {
		return id, err
	}
	var owner uuid.UUID
	if err := r.h.db.QueryRow(r.ctx, `SELECT project_id FROM `+table+` WHERE id = $1 AND tenant_id = $2`,
		id, r.tenant).Scan(&owner); err != nil {
		return id, err
	}
	if owner != pid {
		return id, invalid(k, k+" belongs to another project")
	}
	return id, nil
}

// manages: the caller is a project admin or pid's manager.
func (r *request) manages(pid uuid.UUID) (bool, error) {
	return r.h.manages(r.ctx, r.tenant, r.user, pid)
}

func (h *Handler) manages(ctx context.Context, tenant, user, pid uuid.UUID) (bool, error) {
	if IsAdmin(ctx, h.perms) {
		return true, nil
	}
	var mine bool
	err := h.db.QueryRow(ctx, `SELECT manager_id = $3 FROM project WHERE id = $1 AND tenant_id = $2`, pid, tenant, user).Scan(&mine)
	if errors.Is(err, orm.ErrNotFound) {
		return false, nil
	}
	return mine, err
}

func (r *request) requireManage(pids ...uuid.UUID) error {
	for _, pid := range pids {
		ok, err := r.manages(pid)
		if err != nil {
			return err
		}
		if !ok {
			return errForbidden
		}
	}
	return nil
}

// storedRef is the stored id in k (uuid.Nil on a create).
func (r *request) storedRef(k string) uuid.UUID {
	s, _ := r.stored[k].(string)
	id, _ := uuid.Parse(s)
	return id
}

func (r *request) defaults(kv map[string]any) {
	if r.op != opCreate {
		return
	}
	for k, v := range kv {
		if r.body[k] == nil {
			r.body[k] = v
		}
	}
}

// guard builds the middleware running rules on table's writes.
func (h *Handler) guard(table string, rules func(*request) error) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			r, err := h.load(c, table)
			if err == nil {
				err = rules(r)
			}
			if err != nil {
				return respond(c, err)
			}
			if c.Request().Method != http.MethodDelete && !strings.HasSuffix(c.Path(), "/restore") {
				raw, _ := json.Marshal(r.body)
				c.Request().Body = io.NopCloser(bytes.NewReader(raw))
			}
			return next(c)
		}
	}
}

// load reads the caller, the stored row (404 unless visible; a restore reads
// the deleted row and checks it as a create) and the JSON body.
func (h *Handler) load(c *echo.Context, table string) (*request, error) {
	ctx := c.Request().Context()
	who, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return nil, errNoCaller
	}
	tenant, _ := access.TenantFromContext(ctx)
	r := &request{h: h, ctx: ctx, tenant: tenant, user: who.UserID}
	restore := strings.HasSuffix(c.Path(), "/restore")
	switch {
	case restore:
		r.op = opCreate
	case c.Request().Method == http.MethodPost:
		r.op = opCreate
	case c.Request().Method == http.MethodDelete:
		r.op = opDelete
	default:
		r.op = opUpdate
	}
	if r.op != opCreate || restore {
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return nil, &rejection{status: http.StatusBadRequest, code: "BAD_REQUEST", msg: "invalid id format"}
		}
		r.id = id
		if !restore {
			ok, err := orm.CanSeeRecord(ctx, h.db, table, id)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, errNotFound
			}
		}
		row, err := h.row(ctx, table, id, tenant, !restore)
		if err != nil {
			return nil, err
		}
		if restore {
			r.body = row
			return r, nil
		}
		r.stored = row
	}
	if r.op == opDelete {
		return r, nil
	}
	if err := json.NewDecoder(c.Request().Body).Decode(&r.body); err != nil || r.body == nil {
		return nil, &rejection{status: http.StatusBadRequest, code: "BAD_REQUEST", msg: "malformed body"}
	}
	return r, nil
}

// row reads one row of table as JSON values, live or deleted.
func (h *Handler) row(ctx context.Context, table string, id, tenant uuid.UUID, live bool) (map[string]any, error) {
	var raw []byte
	err := h.db.QueryRow(ctx, `SELECT to_jsonb(t) FROM `+table+` t
		WHERE id = $1 AND tenant_id = $2 AND (deleted_at IS NULL) = $3`, id, tenant, live).Scan(&raw)
	if errors.Is(err, orm.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	var m map[string]any
	return m, json.Unmarshal(raw, &m)
}

// ── Rules per table ──────────────────────────────────────────────────────────

func projectRules(r *request) error {
	if r.op == opCreate && r.id == uuid.Nil { // a POST: anyone with write
		if r.body["manager_id"] == nil {
			r.body["manager_id"] = r.user.String()
		}
		r.defaults(map[string]any{"description": "", "visibility": "everyone", "active": true})
		return nil
	}
	return r.requireManage(r.id) // edit, delete, restore
}

// fixedProject refuses moving a member, stage or milestone to another
// project: the tasks pointing at it would leave the same-project invariant.
func fixedProject(r *request) error {
	if r.op == opUpdate && r.changed("project_id") {
		return invalid("project_id", "project_id can't change: create the row in the other project instead")
	}
	return nil
}

// managedChildRules: members and stages, written by the manager or an admin.
func managedChildRules(extra func(*request, uuid.UUID) error) func(*request) error {
	return func(r *request) error {
		if err := fixedProject(r); err != nil {
			return err
		}
		pid, err := r.visibleRef("project", "project_id", true)
		if err != nil {
			return err
		}
		if err := r.requireManage(pid); err != nil {
			return err
		}
		if extra != nil {
			return extra(r, pid)
		}
		return nil
	}
}

var memberRules = managedChildRules(nil)

var stageRules = managedChildRules(func(r *request, pid uuid.UUID) error {
	if r.op != opCreate || r.body["sequence"] != nil {
		r.defaults(map[string]any{"closed": false})
		return nil
	}
	var next int // a new column goes last
	if err := r.h.db.QueryRow(r.ctx, `SELECT COALESCE(max(sequence), 0) + 10 FROM project_stage
		WHERE project_id = $1 AND deleted_at IS NULL`, pid).Scan(&next); err != nil {
		return err
	}
	r.defaults(map[string]any{"closed": false, "sequence": next})
	return nil
})

func taskRules(r *request) error {
	if r.op == opDelete {
		return nil
	}
	pid, err := r.visibleRef("project", "project_id", true)
	if err != nil {
		return err
	}
	if r.stored != nil && r.changed("project_id") { // a move: UpdateTask does the rest
		parent, err := r.ref("parent_id")
		if err == nil && parent != uuid.Nil {
			err = invalid("project_id", "a subtask can't change project: move its parent task, or clear parent_id first")
		}
		return err
	}
	r.defaults(map[string]any{"description": "", "priority": false, "planned_hours": 0, "sequence": 0})
	if r.op == opCreate && r.get("stage_id") == nil {
		var first *string
		if err := r.h.db.QueryRow(r.ctx, `SELECT (SELECT id::text FROM project_stage WHERE project_id = $1 AND deleted_at IS NULL
			ORDER BY sequence, created_at LIMIT 1)`, pid).Scan(&first); err != nil {
			return err
		}
		if first != nil {
			r.body["stage_id"] = *first
		}
	}
	if _, err := r.inProject("project_stage", "stage_id", pid); err != nil {
		return err
	}
	if _, err := r.inProject("project_milestone", "milestone_id", pid); err != nil {
		return err
	}
	parent, err := r.inProject("project_task", "parent_id", pid)
	if err != nil || parent == uuid.Nil || !r.changed("parent_id") || r.id == uuid.Nil {
		return err
	}
	// parent_id must not be the task itself nor one of its descendants.
	var cycle bool
	if err := r.h.db.QueryRow(r.ctx, `WITH RECURSIVE up AS (
			SELECT $1::uuid AS id
			UNION SELECT t.parent_id FROM project_task t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL)
		SELECT EXISTS (SELECT 1 FROM up WHERE id = $2)`, parent, r.id).Scan(&cycle); err != nil {
		return err
	}
	if cycle {
		return invalid("parent_id", "a task can't be its own parent or ancestor")
	}
	return nil
}

// taskLinkRules: a row hanging off a task (assignee, tag, dependency,
// timesheet). Its project_id is the task's, whatever the client sent.
func taskLinkRules(extra func(*request, uuid.UUID) error) func(*request) error {
	return func(r *request) error {
		if r.op == opDelete {
			if extra != nil {
				return extra(r, r.storedRef("project_id"))
			}
			return nil
		}
		task, err := r.visibleRef("project_task", "task_id", true)
		if err != nil {
			return err
		}
		var pid uuid.UUID
		if err := r.h.db.QueryRow(r.ctx, `SELECT project_id FROM project_task WHERE id = $1 AND tenant_id = $2`,
			task, r.tenant).Scan(&pid); err != nil {
			return err
		}
		r.body["project_id"] = pid
		if extra != nil {
			return extra(r, pid)
		}
		return nil
	}
}

var userLinkRules = taskLinkRules(nil)

var tagLinkRules = taskLinkRules(func(r *request, _ uuid.UUID) error {
	tag, err := r.ref("tag_id")
	if err != nil || !r.changed("tag_id") {
		return err
	}
	var ok bool // project_tag has no row scope: check the tenant
	if err := r.h.db.QueryRow(r.ctx, `SELECT EXISTS (SELECT 1 FROM project_tag
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL)`, tag, r.tenant).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return invalid("tag_id", "tag_id not found")
	}
	return nil
})

var dependencyRules = taskLinkRules(func(r *request, _ uuid.UUID) error {
	on, err := r.visibleRef("project_task", "depends_on_id", true)
	if err != nil {
		return err
	}
	task, _ := r.ref("task_id")
	if on == task {
		return invalid("depends_on_id", "a task can't depend on itself")
	}
	if !r.changed("task_id") && !r.changed("depends_on_id") {
		return nil
	}
	// depends_on_id must not already (transitively) depend on task_id.
	var cycle bool
	if err := r.h.db.QueryRow(r.ctx, `WITH RECURSIVE dep AS (
			SELECT $1::uuid AS id
			UNION SELECT d.depends_on_id FROM project_task_dependency d JOIN dep ON d.task_id = dep.id
			WHERE d.deleted_at IS NULL AND d.tenant_id = $3 AND d.id <> $4)
		SELECT EXISTS (SELECT 1 FROM dep WHERE id = $2)`, on, task, r.tenant, r.id).Scan(&cycle); err != nil {
		return err
	}
	if cycle {
		return invalid("depends_on_id", "this dependency would create a cycle")
	}
	return nil
})

// timesheetRules: a user logs hours as themselves; another user's line is
// written by the project's manager or an admin.
var timesheetRules = taskLinkRules(func(r *request, pid uuid.UUID) error {
	if r.op == opCreate && r.body["user_id"] == nil {
		r.body["user_id"] = r.user.String()
	}
	others := r.stored != nil && r.storedRef("user_id") != r.user
	if r.op != opDelete {
		user, err := r.ref("user_id")
		if err != nil {
			return err
		}
		others = others || user != r.user
		if h, ok := r.get("hours").(float64); !ok || h <= 0 {
			return invalid("hours", "hours must be greater than 0")
		}
		if d, _ := r.get("date").(string); d == "" {
			return invalid("date", "date is required")
		}
		r.defaults(map[string]any{"description": ""})
	}
	if !others {
		return nil
	}
	pids := []uuid.UUID{pid}
	if old := r.storedRef("project_id"); old != uuid.Nil && old != pid {
		pids = append(pids, old)
	}
	return r.requireManage(pids...)
})

// milestoneRules: reached_at is the server's: stamped when reached turns
// true, cleared when it turns false.
func milestoneRules(r *request) error {
	if r.op == opDelete {
		return nil
	}
	if err := fixedProject(r); err != nil {
		return err
	}
	if _, err := r.visibleRef("project", "project_id", true); err != nil {
		return err
	}
	r.defaults(map[string]any{"reached": false})
	was := r.stored != nil && r.stored["reached"] == true
	now := r.get("reached") == true
	switch {
	case r.body["reached"] == nil && r.stored != nil:
		delete(r.body, "reached_at")
	case now && !was:
		r.body["reached_at"] = time.Now()
	case now:
		delete(r.body, "reached_at")
	default:
		r.body["reached_at"] = nil
	}
	return nil
}

// ── Middlewares, in front of the generic writes (mounted by Mount) ───────────

// ValidateProjectBody: a creator becomes manager unless one is given; any
// other write (edit, delete, restore) is the manager's or an admin's.
func (h *Handler) ValidateProjectBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project", projectRules)(next)
}

// ValidateStageBody: stages are written by the project's manager or an admin.
func (h *Handler) ValidateStageBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project_stage", stageRules)(next)
}

// ValidateMemberBody: members are written by the project's manager or an admin.
func (h *Handler) ValidateMemberBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project_member", memberRules)(next)
}

// ValidateTaskBody: references inside the task's project, no parent cycle,
// the first stage by default; a subtask can't change project.
func (h *Handler) ValidateTaskBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project_task", taskRules)(next)
}

// ValidateMilestoneBody: a visible project; reached_at follows reached.
func (h *Handler) ValidateMilestoneBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project_milestone", milestoneRules)(next)
}

// ValidateDependencyBody: both tasks visible (any project), no cycle.
func (h *Handler) ValidateDependencyBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project_task_dependency", dependencyRules)(next)
}

// ValidateTaskLinkBody: an assignee (project_task_user) or tag
// (project_task_tag) link of a visible task.
func (h *Handler) ValidateTaskLinkBody(table string) echo.MiddlewareFunc {
	if table == "project_task_tag" {
		return h.guard(table, tagLinkRules)
	}
	return h.guard(table, userLinkRules)
}

// ValidateTimesheetBody: hours > 0, a date, the caller's own line unless
// they manage the project.
func (h *Handler) ValidateTimesheetBody(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guard("project_timesheet", timesheetRules)(next)
}
