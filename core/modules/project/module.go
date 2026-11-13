// Package project is the Project app: projects, stages, tasks and subtasks,
// dependencies, milestones and timesheets, all on the generic CRUD surface.
// Members-only projects are enforced by row scopes (scope.go, ADR-038); the
// computed figures are stored and kept by Postgres triggers (migrate.go).
package project

import (
	"core/internal/module"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&projectModule{})
}

type projectModule struct{}

func (m *projectModule) Name() string { return "project" }

func (m *projectModule) Register() error {
	p := currentPermissions
	for _, err := range []error{
		orm.Register[Project](orm.WithTableName("project"), orm.WithRowScope(ProjectScope(p)),
			orm.WithReadOnlyFields("task_count", "planned_hours", "spent_hours")),
		orm.Register[ProjectMember](orm.WithTableName("project_member"), orm.WithRowScope(ChildScope(p))),
		orm.Register[ProjectStage](orm.WithTableName("project_stage"), orm.WithRowScope(StageScope(p))),
		orm.Register[ProjectTask](orm.WithTableName("project_task"), orm.WithRowScope(TaskScope(p)),
			orm.WithReadOnlyFields("spent_hours", "subtask_hours", "subtask_count", "subtask_done_count", "blocked", "closed")),
		orm.Register[ProjectTaskUser](orm.WithTableName("project_task_user"), orm.WithRowScope(TaskChildScope(p))),
		orm.Register[ProjectTag](orm.WithTableName("project_tag")),
		orm.Register[ProjectTaskTag](orm.WithTableName("project_task_tag"), orm.WithRowScope(TaskChildScope(p))),
		orm.Register[ProjectColor](orm.WithTableName("project_color")),
		orm.Register[ProjectTaskColor](orm.WithTableName("project_task_color"), orm.WithRowScope(TaskChildScope(p))),
		orm.Register[ProjectTaskDependency](orm.WithTableName("project_task_dependency"), orm.WithRowScope(DependencyScope(p))),
		orm.Register[ProjectMilestone](orm.WithTableName("project_milestone"), orm.WithRowScope(ChildScope(p)),
			orm.WithReadOnlyFields("task_count", "task_done_count")),
		orm.Register[ProjectTimesheet](orm.WithTableName("project_timesheet"), orm.WithRowScope(TaskChildScope(p))),
		orm.Register[ProjectObsBox](orm.WithTableName("project_obs_box"), orm.WithRowScope(ChildScope(p))),
	} {
		if err != nil {
			return err
		}
	}
	return nil
}
