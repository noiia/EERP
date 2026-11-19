package notify_test

import (
	"context"
	"testing"

	"core/internal/notify"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/notify"

	"github.com/google/uuid"
)

// Boot syncs every registered category into each tenant's catalog and gives
// the admin role each category the first time it appears — but never re-adds
// one an admin removed later.
// A full-access role ("*:*:*") is an admin even without the "admin"
// technical name — the dev admin's own role is one — and gets every category.
func TestMigrate_GrantsFullAccessRoles(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	tenant, role := uuid.New(), uuid.New()
	code := "*:*:*"
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, role)
		for _, table := range []string{"role_notification_category", "notification_category", "roles", "users"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	testdb.MigrateModules(t, app, "auth")
	if _, err := app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`, uuid.New(), tenant, uuid.NewString()+"@t.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, 'admin')`, role, tenant); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO permissions (code, description, module) VALUES ($1, 'full', '*') ON CONFLICT DO NOTHING`, code); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = $2`, role, code); err != nil {
		t.Fatal(err)
	}

	testdb.MigrateModules(t, app, "notify")

	keys := []string{}
	for _, c := range notify.Categories() {
		keys = append(keys, c.Key)
	}
	var granted int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM role_notification_category rnc
		JOIN notification_category c ON c.id = rnc.notification_category_id
		WHERE rnc.role_id = $1 AND rnc.deleted_at IS NULL AND c.key = ANY($2)`, role, keys).Scan(&granted)
	if granted != len(keys) {
		t.Errorf("full-access role grants = %d, want %d", granted, len(keys))
	}
}

func TestMigrate_SyncsCatalogAndAdminDefaults(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	tenant := uuid.New()
	adminRole := uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{"role_notification_category", "notification_category", "roles", "users"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	testdb.MigrateModules(t, app, "auth")
	if _, err := app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`, uuid.New(), tenant, uuid.NewString()+"@t.example"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO roles (id, tenant_id, name, technical_name) VALUES ($1, $2, 'Admin', 'admin')`, adminRole, tenant); err != nil {
		t.Fatal(err)
	}

	testdb.MigrateModules(t, app, "notify")

	// Only this binary's registered categories are counted: package tests run
	// in parallel against one database, and another binary may sync more.
	keys := []string{}
	for _, c := range notify.Categories() {
		keys = append(keys, c.Key)
	}
	countAdmin := func() (granted int) {
		_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM role_notification_category rnc
			JOIN notification_category c ON c.id = rnc.notification_category_id
			WHERE rnc.role_id = $1 AND rnc.deleted_at IS NULL AND c.key = ANY($2)`, adminRole, keys).Scan(&granted)
		return granted
	}
	var cats int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM notification_category WHERE tenant_id = $1 AND deleted_at IS NULL AND key = ANY($2)`, tenant, keys).Scan(&cats)
	granted := countAdmin()
	if want := len(notify.Categories()); cats != want || granted != want {
		t.Fatalf("catalog = %d, admin grants = %d, want %d each", cats, granted, want)
	}

	// An admin unticks "cron"; the next boot must not re-add it.
	if _, err := app.DB.Exec(ctx, `DELETE FROM role_notification_category rnc USING notification_category c
		WHERE rnc.notification_category_id = c.id AND c.key = 'cron' AND rnc.role_id = $1`, adminRole); err != nil {
		t.Fatal(err)
	}
	testdb.MigrateModules(t, app, "notify")
	granted = countAdmin()
	if granted != len(notify.Categories())-1 {
		t.Errorf("admin grants after reboot = %d, want %d (cron stays removed)", granted, len(notify.Categories())-1)
	}
}
