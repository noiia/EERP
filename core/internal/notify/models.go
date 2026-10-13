// Package notify is the core notification system: global activities (a cron
// run, a demo-data seed…) with live progress, visible to the roles allowed the
// activity's category, and personal notifications visible to their owner only.
// See docs/adr/ADR-031-notifications.md.
package notify

import (
	"time"

	"core/orm/model"

	"github.com/google/uuid"
)

// Notification is one personal message (UserID set) or global activity
// (UserID nil). Off the generic CRUD surface: only the privacy-filtered
// handlers in this package read it.
type Notification struct {
	model.BaseModel
	UserID        *uuid.UUID `db:"user_id" json:"-"`
	Category      string     `db:"category" json:"category"`
	Kind          string     `db:"kind" json:"kind"` // "message" | "activity"
	Title         string     `db:"title" json:"title"`
	Body          string     `db:"body" json:"body"`
	Link          string     `db:"link" json:"link"`
	Status        *string    `db:"status" json:"status"` // activities: running|done|failed
	Progress      *int       `db:"progress" json:"progress"`
	ProgressLabel *string    `db:"progress_label" json:"progress_label"`
	ActorID       *uuid.UUID `db:"actor_id" json:"-"`
	FinishedAt    *time.Time `db:"finished_at" json:"finished_at"`
	// Data is opaque JSON for the page the notification links to (e.g. a
	// seed's per-entity results). Never interpreted server-side.
	Data *string `db:"data" json:"data"`
}

// NotificationRead marks one notification read for one user.
type NotificationRead struct {
	model.BaseModel
	UserID         uuid.UUID `db:"user_id"`
	NotificationID uuid.UUID `db:"notification_id"`
	ReadAt         time.Time `db:"read_at"`
}

// NotificationCategory is a tenant's copy of a registered Category — the
// catalog the role form's Notifications tags widget offers (synced at boot,
// modules/notify).
type NotificationCategory struct {
	model.BaseModel
	Key   string `db:"key" json:"key"`
	Label string `db:"label" json:"label"`
	// Name mirrors Label so the stock relation widgets (labelField "name") read it.
	Name string `db:"name" json:"name"`
}

// RoleNotificationCategory allows a role (and every role belonging to it) the
// global activities of one category. Rides the generic CRUD surface like
// role_belongs, so the role form needs no bespoke endpoint.
type RoleNotificationCategory struct {
	model.BaseModel
	RoleID                 uuid.UUID `db:"role_id" json:"role_id"`
	NotificationCategoryID uuid.UUID `db:"notification_category_id" json:"notification_category_id"`
}
