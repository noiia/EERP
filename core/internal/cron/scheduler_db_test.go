package cron

import (
	"context"
	"errors"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/chatter"
	"core/internal/testdb"
	_ "core/modules/auth"    // registers the auth module for testdb.MigrateModules
	_ "core/modules/chatter" // registers the chatter module
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// TestScheduler_Tick drives one real scheduler tick against the test database:
// due crons run (success, action error, missing/granted permission), crons that
// aren't due or aren't active are left alone, and every run leaves exactly one
// cron_history row and clears execution_date.
func TestScheduler_Tick(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "chatter")
	if err := orm.Register[Cron](); err != nil {
		t.Fatal(err)
	}
	if err := orm.Register[CronHistory](); err != nil {
		t.Fatal(err)
	}
	testdb.Migrate(t, app, "cron", "cron_history")
	ctx := context.Background()
	db := app.DB

	clearForTest()
	t.Cleanup(clearForTest)
	perm := "crontest:gate:" + uuid.NewString()[:8]
	for _, a := range []Action{
		{ID: "test.ok", Label: "ok", Run: func(context.Context) error { return nil }},
		{ID: "test.fail", Label: "fail", Run: func(context.Context) error { return errors.New("boom") }},
		{ID: "test.gated", Label: "gated", RequiredPermission: perm, Run: func(context.Context) error { return nil }},
	} {
		Register(a)
	}

	// One tenant, two users: one whose role grants perm, one with no role at all.
	tenant := uuid.New()
	roleName := "crontest-" + uuid.NewString()[:8] // role names are matched globally
	var granted, plain, roleID, permID uuid.UUID
	for _, q := range []struct {
		sql  string
		args []any
		dest *uuid.UUID
	}{
		{`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'granted@crontest.invalid', 'x') RETURNING id`, []any{tenant}, &granted},
		{`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'plain@crontest.invalid', 'x') RETURNING id`, []any{tenant}, &plain},
		{`INSERT INTO roles (tenant_id, name) VALUES ($1, $2) RETURNING id`, []any{tenant, roleName}, &roleID},
		{`INSERT INTO permissions (code, description, module) VALUES ($1, 'cron test', 'crontest') RETURNING id`, []any{perm}, &permID},
	} {
		if err := db.QueryRow(ctx, q.sql, q.args...).Scan(q.dest); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, []any{tenant, granted, roleID}},
		{`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, []any{roleID, permID}},
	} {
		if _, err := db.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM cron_history WHERE tenant_id = $1`,
			`DELETE FROM chatter_message WHERE tenant_id = $1`,
			`DELETE FROM cron WHERE tenant_id = $1`,
			`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1)`,
			`DELETE FROM user_roles WHERE tenant_id = $1`,
			`DELETE FROM users WHERE tenant_id = $1`,
			`DELETE FROM roles WHERE tenant_id = $1`,
		} {
			_, _ = db.Exec(ctx, q, tenant)
		}
		_, _ = db.Exec(ctx, `DELETE FROM permissions WHERE id = $1`, permID)
	})

	past, future := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	tests := []struct {
		name        string
		action      string
		runAs       *uuid.UUID
		status      string
		due         *time.Time
		wantRuns    int
		wantFailed  bool
		wantChatter bool
	}{
		{"due and allowed runs cleanly", "test.ok", &plain, "active", &past, 1, false, false},
		{"action error is recorded as a failed run", "test.fail", &plain, "active", &past, 1, true, false},
		{"missing permission fails and tells the record's chatter", "test.gated", &plain, "active", &past, 1, true, true},
		{"granted permission runs", "test.gated", &granted, "active", &past, 1, false, false},
		{"not yet due is left alone", "test.ok", &plain, "active", &future, 0, false, false},
		{"inactive is left alone", "test.ok", &plain, "deactivated", &past, 0, false, false},
	}
	crons := orm.MustRepo[Cron](db)
	ids := make([]uuid.UUID, len(tests))
	for i, tt := range tests {
		c, err := crons.Create(ctx, Cron{BaseModel: model.BaseModel{TenantID: tenant}, Name: tt.name,
			ActionID: tt.action, RunAsUserID: tt.runAs, Status: tt.status, ExecutionDate: tt.due, HistoryRetentionYears: 1})
		if err != nil {
			t.Fatalf("seed cron %q: %v", tt.name, err)
		}
		ids[i] = c.ID
	}

	s := NewScheduler(db, auth.NewUserRepository(db), auth.NewPermissionRepository(db), chatter.NewRepository(db), t.TempDir())
	s.tick(ctx)

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var runs, failedRuns, chatterRows int
			var stillDue bool
			if err := db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE failed) FROM cron_history WHERE cron_id = $1`, ids[i]).Scan(&runs, &failedRuns); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(ctx, `SELECT execution_date IS NOT NULL FROM cron WHERE id = $1`, ids[i]).Scan(&stillDue); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(ctx, `SELECT count(*) FROM chatter_message WHERE record_id = $1`, ids[i]).Scan(&chatterRows); err != nil {
				t.Fatal(err)
			}
			if runs != tt.wantRuns || (failedRuns == 1) != tt.wantFailed {
				t.Errorf("runs = %d (failed %d), want %d (failed %v)", runs, failedRuns, tt.wantRuns, tt.wantFailed)
			}
			if tt.wantRuns == 1 && stillDue {
				t.Error("execution_date not cleared after the run")
			}
			if (chatterRows > 0) != tt.wantChatter {
				t.Errorf("chatter rows = %d, want chatter %v", chatterRows, tt.wantChatter)
			}
		})
	}
}
