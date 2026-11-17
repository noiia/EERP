package project

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// Optional columns are pointers: the generic CRUD layer requires every
// non-pointer, writable column on create. Read-only columns (task_count,
// spent_hours, blocked…) are kept by the triggers in migrate.go.

// Project groups tasks. visibility "members" hides it from everyone but its
// manager, its live members and project admins (scope.go).
type Project struct {
	model.BaseModel
	TenantID     uuid.UUID  `db:"tenant_id"`
	Name         string     `db:"name" json:"name"`
	Description  string     `db:"description" json:"description"`
	ManagerID    uuid.UUID  `db:"manager_id,index" json:"manager_id"`
	CompanyID    *uuid.UUID `db:"company_id,index" json:"company_id"` // a contact of kind "company"
	Visibility   string     `db:"visibility" json:"visibility"`       // "everyone" | "members"
	DateStart    *time.Time `db:"date_start" json:"date_start"`
	DateEnd      *time.Time `db:"date_end" json:"date_end"`
	Active       bool       `db:"active" json:"active"`
	TaskCount    int        `db:"task_count" json:"task_count"`
	PlannedHours float64    `db:"planned_hours" json:"planned_hours"`
	SpentHours   float64    `db:"spent_hours" json:"spent_hours"`
}

// ProjectMember makes a user see a members-only project. Unique live pair.
type ProjectMember struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	UserID    uuid.UUID `db:"user_id,index" json:"user_id"`
}

// ProjectStage is one kanban column of a project; a task in a closed stage
// is done.
type ProjectStage struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	Name      string    `db:"name" json:"name"`
	Sequence  int       `db:"sequence" json:"sequence"`
	Closed    bool      `db:"closed" json:"closed"`
}

// ProjectTask is a task or, with parent_id, a subtask.
type ProjectTask struct {
	model.BaseModel
	TenantID         uuid.UUID  `db:"tenant_id"`
	ProjectID        uuid.UUID  `db:"project_id,index" json:"project_id"`
	StageID          *uuid.UUID `db:"stage_id,index" json:"stage_id"`
	ParentID         *uuid.UUID `db:"parent_id,index" json:"parent_id"`
	MilestoneID      *uuid.UUID `db:"milestone_id,index" json:"milestone_id"`
	Name             string     `db:"name" json:"name"`
	Description      string     `db:"description" json:"description"`
	Priority         bool       `db:"priority" json:"priority"`
	DateStart        *time.Time `db:"date_start" json:"date_start"`
	Deadline         *time.Time `db:"deadline" json:"deadline"`
	PlannedHours     float64    `db:"planned_hours" json:"planned_hours"`
	Sequence         int        `db:"sequence" json:"sequence"`     // position among its siblings, kept 1..n by trigger
	WbsNumber        *string    `db:"wbs_number" json:"wbs_number"` // order number, "3.1.2"; trigger-maintained
	SpentHours       float64    `db:"spent_hours" json:"spent_hours"`
	SubtaskHours     float64    `db:"subtask_hours" json:"subtask_hours"`
	SubtaskCount     int        `db:"subtask_count" json:"subtask_count"`
	SubtaskDoneCount int        `db:"subtask_done_count" json:"subtask_done_count"`
	Blocked          bool       `db:"blocked,index" json:"blocked"`
	Closed           bool       `db:"closed" json:"closed"` // mirror of its stage's
	ClosedAt         *time.Time `db:"closed_at" json:"closed_at"` // when it moved into a closed stage (migrate.go)
}

// ProjectTaskUser assigns a user to a task (an assignee sees the task even
// when its project is hidden from them). Unique live pair.
type ProjectTaskUser struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	TaskID    uuid.UUID `db:"task_id,index" json:"task_id"`
	UserID    uuid.UUID `db:"user_id,index" json:"user_id"`
}

// ProjectTag is a label shared by every project (no row scope).
type ProjectTag struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name" json:"name"`
}

// ProjectTaskTag links a task to a tag.
type ProjectTaskTag struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	TaskID    uuid.UUID `db:"task_id,index" json:"task_id"`
	TagID     uuid.UUID `db:"tag_id,index" json:"tag_id"`
}

// ProjectColor is a color group shared by every project (no row scope):
// color is a lowercase "#rrggbb" (validate.go).
type ProjectColor struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name" json:"name"`
	Color    string    `db:"color" json:"color"`
}

// ProjectTaskColor puts a task in a color group. Unique live pair.
type ProjectTaskColor struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	TaskID    uuid.UUID `db:"task_id,index" json:"task_id"`
	ColorID   uuid.UUID `db:"color_id,index" json:"color_id"`
}

// ProjectTaskDependency: task_id is blocked until depends_on_id is closed.
// project_id is task_id's (a dependency may cross projects).
type ProjectTaskDependency struct {
	model.BaseModel
	TenantID    uuid.UUID `db:"tenant_id"`
	ProjectID   uuid.UUID `db:"project_id,index" json:"project_id"`
	TaskID      uuid.UUID `db:"task_id,index" json:"task_id"`
	DependsOnID uuid.UUID `db:"depends_on_id,index" json:"depends_on_id"`
}

// ProjectMilestone groups tasks toward a deadline.
type ProjectMilestone struct {
	model.BaseModel
	TenantID      uuid.UUID  `db:"tenant_id"`
	ProjectID     uuid.UUID  `db:"project_id,index" json:"project_id"`
	Name          string     `db:"name" json:"name"`
	Deadline      *time.Time `db:"deadline" json:"deadline"`
	Reached       bool       `db:"reached" json:"reached"`
	ReachedAt     *time.Time `db:"reached_at" json:"reached_at"`
	TaskCount     int        `db:"task_count" json:"task_count"`
	TaskDoneCount int        `db:"task_done_count" json:"task_done_count"`
}

// ProjectTimesheet is hours a user spent on a task.
type ProjectTimesheet struct {
	model.BaseModel
	TenantID    uuid.UUID `db:"tenant_id"`
	ProjectID   uuid.UUID `db:"project_id,index" json:"project_id"`
	TaskID      uuid.UUID `db:"task_id,index" json:"task_id"`
	UserID      uuid.UUID `db:"user_id,index" json:"user_id"`
	Date        time.Time `db:"date" json:"date"`
	Hours       float64   `db:"hours" json:"hours"`
	Description string    `db:"description" json:"description"`
}

// ProjectObsBox is one box of a project's OBS (organizational breakdown
// structure) chart: a contact, a staff user or free text, under an optional
// parent box of the same project. Written by the project's manager only.
type ProjectObsBox struct {
	model.BaseModel
	TenantID  uuid.UUID  `db:"tenant_id"`
	ProjectID uuid.UUID  `db:"project_id,index" json:"project_id"`
	ParentID  *uuid.UUID `db:"parent_id,index" json:"parent_id"`
	Kind      string     `db:"kind" json:"kind"`             // "contact" | "user" | "text"
	ContactID *uuid.UUID `db:"contact_id" json:"contact_id"` // kind contact only
	UserID    *uuid.UUID `db:"user_id" json:"user_id"`       // kind user only
	Title     *string    `db:"title" json:"title"`           // the role, ≤ 200 chars
	Text      *string    `db:"text" json:"text"`             // ≤ 2000 chars
	Color     *string    `db:"color" json:"color"`           // "#rrggbb" lowercase or null
	X         float64    `db:"x" json:"x"`
	Y         float64    `db:"y" json:"y"`
}

// ProjectRisk is one entry of a project's risk register. Likelihood and detectability are 1-3, severity 1-4;
// severity_effective and criticity are generated by Postgres (migrate.go),
// severity_computed is written by the service from the linked tasks.
type ProjectRisk struct {
	model.BaseModel
	TenantID              uuid.UUID  `db:"tenant_id"`
	ProjectID             uuid.UUID  `db:"project_id,index" json:"project_id"`
	Name                  string     `db:"name" json:"name"`
	Description           *string    `db:"description" json:"description"`
	CategoryID            *uuid.UUID `db:"category_id" json:"category_id"`
	PhaseTaskID           *uuid.UUID `db:"phase_task_id" json:"phase_task_id"`
	ImpactOn              string     `db:"impact_on" json:"impact_on"`
	Likelihood            *int       `db:"likelihood" json:"likelihood"`
	Detectability         *int       `db:"detectability" json:"detectability"`
	Severity              *int       `db:"severity" json:"severity"`
	SeverityComputed      *int       `db:"severity_computed" json:"severity_computed"`
	SeverityNote          *string    `db:"severity_note" json:"severity_note"`
	SeverityEffective     *int       `db:"severity_effective,generated" json:"severity_effective"`
	Criticity             *int       `db:"criticity,generated" json:"criticity"`
	Remediation           *string    `db:"remediation" json:"remediation"`
	ResidualLikelihood    *int       `db:"residual_likelihood" json:"residual_likelihood"`
	ResidualDetectability *int       `db:"residual_detectability" json:"residual_detectability"`
	ResidualSeverity      *int       `db:"residual_severity" json:"residual_severity"`
	ResidualCriticity     *int       `db:"residual_criticity,generated" json:"residual_criticity"`
	ResponsibleID         *uuid.UUID `db:"responsible_id" json:"responsible_id"`
	Deadline              *time.Time `db:"deadline" json:"deadline"`
}

// ProjectRiskTask links a risk to a task it endangers, with the estimated
// impact on that task. project_id is the risk's.
type ProjectRiskTask struct {
	model.BaseModel
	TenantID   uuid.UUID `db:"tenant_id"`
	ProjectID  uuid.UUID `db:"project_id,index" json:"project_id"`
	RiskID     uuid.UUID `db:"risk_id,index" json:"risk_id"`
	TaskID     uuid.UUID `db:"task_id,index" json:"task_id"`
	DelayDays  *float64  `db:"delay_days" json:"delay_days"`
	ExtraHours *float64  `db:"extra_hours" json:"extra_hours"`
}

// ProjectRiskCategory is a workspace-wide risk category (seeded per tenant).
type ProjectRiskCategory struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	Name     string    `db:"name" json:"name"`
	Color    *string   `db:"color" json:"color"`
}

// ProjectTaskStage is one span of a task's life in a stage: entered_at when
// it moved in, left_at when it moved on (stage, project) or was deleted.
// Kept by the trigger in migrate.go — one open row (left_at NULL) per live
// task that has a stage, backfilled with entered_at = created_at for tasks
// that predate it. Deliberately NOT model.BaseModel (no created/updated/deleted
// columns: the span IS the row's whole state); excluded from the HTTP surface.
type ProjectTaskStage struct {
	ID        uuid.UUID  `db:"id,pk"`
	TenantID  uuid.UUID  `db:"tenant_id,index"`
	TaskID    uuid.UUID  `db:"task_id,index"`
	ProjectID uuid.UUID  `db:"project_id,index"`
	StageID   uuid.UUID  `db:"stage_id"`
	EnteredAt time.Time  `db:"entered_at"`
	LeftAt    *time.Time `db:"left_at"`
}

// ProjectRiskHistory snapshots a risk's criticity once a day (recorded_on,
// a DATE), so the register can show how its scores moved. Kept by the trigger
// in migrate.go — an upsert on (risk_id, recorded_on) whenever criticity,
// residual_criticity or the risk's deleted_at changes. Deliberately NOT
// model.BaseModel (no soft delete: a day's row is overwritten, never hidden);
// excluded from the HTTP surface.
type ProjectRiskHistory struct {
	ID                uuid.UUID  `db:"id,pk"`
	TenantID          uuid.UUID  `db:"tenant_id,index"`
	RiskID            uuid.UUID  `db:"risk_id"`
	ProjectID         uuid.UUID  `db:"project_id,index"`
	RecordedOn        time.Time  `db:"recorded_on"` // DATE in the database (Migrate narrows the type)
	Criticity         *int       `db:"criticity"`
	ResidualCriticity *int       `db:"residual_criticity"`
	Deleted           bool       `db:"deleted"`
}

// ProjectBaseline is a named snapshot of a project's tasks: its live tasks'
// start, deadline and planned hours are copied into project_baseline_task at
// creation. The project's manager or an admin creates or deletes one (at
// most baselineLimit live per project); the rows it snapshots are read-only.
type ProjectBaseline struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	Name      string    `db:"name" json:"name"`
	CreatedBy uuid.UUID `db:"created_by" json:"created_by"`
}

// ProjectBaselineTask is the frozen copy of one live task (its dates and
// planned hours) in a baseline's snapshot. Read-only: the guard (validate.go)
// refuses every write.
type ProjectBaselineTask struct {
	model.BaseModel
	TenantID     uuid.UUID  `db:"tenant_id"`
	BaselineID   uuid.UUID  `db:"baseline_id,index" json:"baseline_id"`
	ProjectID    uuid.UUID  `db:"project_id,index" json:"project_id"`
	TaskID       uuid.UUID  `db:"task_id,index" json:"task_id"`
	DateStart    *time.Time `db:"date_start" json:"date_start"`
	Deadline     *time.Time `db:"deadline" json:"deadline"`
	PlannedHours float64    `db:"planned_hours" json:"planned_hours"`
}

// ProjectTaskRaci gives a staff user one R/A/C/I role on a task (the RACI
// matrix). project_id is the task's, set server-side like project_task_user.
// Unique live (task_id, user_id) and one accountable per task (the partial
// unique live (task_id) WHERE role = 'A') are hand-written in migrate.go.
type ProjectTaskRaci struct {
	model.BaseModel
	TenantID  uuid.UUID `db:"tenant_id"`
	ProjectID uuid.UUID `db:"project_id,index" json:"project_id"`
	TaskID    uuid.UUID `db:"task_id,index" json:"task_id"`
	UserID    uuid.UUID `db:"user_id,index" json:"user_id"`
	Role      string    `db:"role" json:"role"` // "R" | "A" | "C" | "I"
}

// ProjectCapacity is a user's planned hours per week for the workload view.
// Shared by the whole tenant (no row scope); a user without a row is 40.
type ProjectCapacity struct {
	model.BaseModel
	TenantID     uuid.UUID `db:"tenant_id"`
	UserID       uuid.UUID `db:"user_id,index" json:"user_id"`
	HoursPerWeek float64   `db:"hours_per_week" json:"hours_per_week"`
}
