// Package notify registers the notification tables and keeps every tenant's
// category catalog in step with the Go registry. Import via core/modules/all.
package notify

import (
	"context"
	"fmt"

	"core/internal/module"
	inotify "core/internal/notify"
	"core/orm"
)

func init() {
	module.RegisterGoModule(&notifyModule{})
}

type notifyModule struct{}

func (m *notifyModule) Name() string { return "notify" }

func (m *notifyModule) Register() error {
	// notification / notification_read stay OFF the generic CRUD surface: only
	// the privacy-filtered handlers in internal/notify may read them.
	if err := orm.Register[inotify.Notification](orm.WithTableName("notification"), orm.WithExcluded()); err != nil {
		return err
	}
	if err := orm.Register[inotify.NotificationRead](orm.WithTableName("notification_read"), orm.WithExcluded()); err != nil {
		return err
	}
	// The catalog and the role junction ride the generic CRUD surface (the
	// role form's tags widget), like account_role_types / role_belongs.
	if err := orm.Register[inotify.NotificationCategory](orm.WithTableName("notification_category")); err != nil {
		return err
	}
	return orm.Register[inotify.RoleNotificationCategory](orm.WithTableName("role_notification_category"))
}

func (m *notifyModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, ddl := range []string{
		`CREATE INDEX IF NOT EXISTS idx_notification_user ON notification (tenant_id, user_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_notification_global ON notification (tenant_id, category, created_at DESC) WHERE user_id IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_read_user ON notification_read (user_id, notification_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_category_key ON notification_category (tenant_id, key) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_notification_category ON role_notification_category (role_id, notification_category_id) WHERE deleted_at IS NULL`,
	} {
		if _, err := db.Exec(ctx, ddl); err != nil {
			return fmt.Errorf("notify: migrate: %w", err)
		}
	}
	return inotify.NewRepository(db).SyncCatalog(ctx)
}
