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
