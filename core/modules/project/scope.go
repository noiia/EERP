package project

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"

	"core/internal/auth"
	"core/orm"
)

// AdminGroup is the role technical name that sees every project.
const AdminGroup = "project_admin"

// adminPermission is the other way to be a project admin (*:*:* grants it).
const adminPermission = "project:project:admin"

var permissions atomic.Pointer[auth.PermissionRepository]

// SetPermissions hands the scopes the permission repository; internal/app
// calls it before serving routes. Until then every scope fails closed.
func SetPermissions(p *auth.PermissionRepository) { permissions.Store(p) }

func currentPermissions() *auth.PermissionRepository { return permissions.Load() }

var (
	errNoPermissions = errors.New("project: permission repository not set")
	errNoCaller      = errors.New("project: no caller identity")
)

// IsAdmin reports whether the caller sees every project: the project_admin
// group, or a role granting project:project:admin. A failed lookup is "no".
func IsAdmin(ctx context.Context, perms *auth.PermissionRepository) bool {
	id, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return false
	}
	if slices.Contains(id.Groups, AdminGroup) {
		return true
	}
	if perms == nil {
		return false
	}
	has, err := perms.Has(ctx, id.Roles, adminPermission)
	return err == nil && has
}

// visibleProjects selects the ids of the live projects of the caller's
// tenant ($2) the caller ($1) may see: public ones, the ones they manage, the
// ones they're a live member of. The tenant predicate is defense in depth:
// the generic repository already pins the outer table's tenant.
const visibleProjects = `SELECT p.id FROM project p WHERE p.deleted_at IS NULL AND p.tenant_id = $2 AND (
	p.visibility = 'everyone' OR p.manager_id = $1 OR EXISTS (
		SELECT 1 FROM project_member pm
		WHERE pm.project_id = p.id AND pm.user_id = $1 AND pm.deleted_at IS NULL))`

// assignedTasks selects the ids of the tasks the caller ($1) is assigned to.
const assignedTasks = `SELECT tu.task_id FROM project_task_user tu WHERE tu.user_id = $1 AND tu.tenant_id = $2 AND tu.deleted_at IS NULL`

// The scope conditions, applied to the unaliased table of each query.
const (
	projectSQL = `(project.tenant_id = $2 AND (visibility = 'everyone' OR manager_id = $1 OR EXISTS (
		SELECT 1 FROM project_member pm
		WHERE pm.project_id = project.id AND pm.user_id = $1 AND pm.deleted_at IS NULL)))`
	childSQL     = `(project_id IN (` + visibleProjects + `))`
	taskSQL      = `(project_id IN (` + visibleProjects + `) OR project_task.id IN (` + assignedTasks + `))`
	taskChildSQL = `(project_id IN (` + visibleProjects + `) OR task_id IN (` + assignedTasks + `))`
	stageSQL     = `(project_id IN (` + visibleProjects + `) OR project_id IN (
		SELECT t.project_id FROM project_task t
		WHERE t.deleted_at IS NULL AND t.id IN (` + assignedTasks + `)))`
)

// scope builds a row scope binding the caller's user id as $1 and tenant as $2. Admins are
// unrestricted; no permission repository or no caller fails closed.
func scope(perms func() *auth.PermissionRepository, sql string) orm.RowScopeFunc {
	return func(ctx context.Context) (orm.Condition, bool, error) {
		p := perms()
		if p == nil {
			return orm.Condition{}, false, errNoPermissions
		}
		id, ok := auth.IdentityFromContext(ctx)
		if !ok {
			return orm.Condition{}, false, errNoCaller
		}
		if IsAdmin(ctx, p) {
			return orm.Condition{}, false, nil
		}
		return orm.Cond(sql, id.UserID, id.TenantID), true, nil
	}
}

// ProjectScope limits project rows to the visible projects.
func ProjectScope(perms func() *auth.PermissionRepository) orm.RowScopeFunc {
	return scope(perms, projectSQL)
}

// ChildScope limits a table with project_id to the visible projects' rows
// (members, milestones).
func ChildScope(perms func() *auth.PermissionRepository) orm.RowScopeFunc {
	return scope(perms, childSQL)
}

// TaskScope: tasks of visible projects, plus the tasks the caller is
// assigned to (not their subtasks).
func TaskScope(perms func() *auth.PermissionRepository) orm.RowScopeFunc {
	return scope(perms, taskSQL)
}

// TaskChildScope: rows of a task (timesheets, assignees, tags,
// dependencies) of visible projects, plus those of the caller's own tasks.
func TaskChildScope(perms func() *auth.PermissionRepository) orm.RowScopeFunc {
	return scope(perms, taskChildSQL)
}

// StageScope: stages of visible projects, plus those of any project the
// caller has a live assigned task in (their task's kanban columns).
func StageScope(perms func() *auth.PermissionRepository) orm.RowScopeFunc {
	return scope(perms, stageSQL)
}
