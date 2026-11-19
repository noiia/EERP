package app

import (
	"context"
	"strings"
	"testing"

	"core/internal/notify"
	"core/internal/testdb"

	"github.com/google/uuid"
)

// On a brand-new database the dev admin is seeded only after the modules
// migrate, so the notification catalog must be synced again after it: the
// admin's role must hold every category from the very first boot.
func TestBuild_FreshDatabaseGivesTheAdminEveryCategory(t *testing.T) {
	cfg := testdb.Config(t)
	cfg.Environment = "development"
	cfg.CronLogDir = t.TempDir()
	cfg.DbName = "eerp_boot_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	admin := testdb.Open(t) // the regular test database, to drop the fresh one after
	t.Cleanup(func() {
		_, _ = admin.DB.Exec(context.Background(), `DROP DATABASE IF EXISTS `+cfg.DbName+` WITH (FORCE)`)
	})

	a, err := Build(context.Background(), cfg, "", false)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	t.Cleanup(a.Close)

	var granted int
	if err := a.db.DB.QueryRow(context.Background(), `
		SELECT count(DISTINCT c.key) FROM user_roles ur
		JOIN role_notification_category rnc ON rnc.role_id = ur.role_id AND rnc.deleted_at IS NULL
		JOIN notification_category c ON c.id = rnc.notification_category_id
		JOIN users u ON u.id = ur.user_id
		WHERE u.email = 'admin@eerp.local'`).Scan(&granted); err != nil {
		t.Fatal(err)
	}
	if want := len(notify.Categories()); granted != want {
		t.Errorf("dev admin categories on a fresh database = %d, want %d", granted, want)
	}
}

// Building the app (as every test does, against a database another server may
// be using) must not mark that server's running activities failed: the
// interrupted-run sweep belongs to a real server start (App.Run).
func TestBuild_LeavesRunningActivitiesAlone(t *testing.T) {
	db := testdb.Open(t)
	testdb.MigrateModules(t, db, "auth", "notify")
	ctx := context.Background()
	tenant := uuid.New()
	t.Cleanup(func() { _, _ = db.DB.Exec(ctx, `DELETE FROM notification WHERE tenant_id = $1`, tenant) })
	var id uuid.UUID
	if err := db.DB.QueryRow(ctx, `INSERT INTO notification (tenant_id, category, kind, title, link, status)
		VALUES ($1, 'dev_seed', 'activity', 'Seeding', '/settings/developer', 'running') RETURNING id`, tenant).Scan(&id); err != nil {
		t.Fatal(err)
	}

	buildApp(t)

	var status string
	_ = db.DB.QueryRow(ctx, `SELECT status FROM notification WHERE id = $1`, id).Scan(&status)
	if status != "running" {
		t.Errorf("status after Build = %q, want running", status)
	}
}
