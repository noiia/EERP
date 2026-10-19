package notify_test

import (
	"context"
	"testing"
	"time"

	"core/internal/notify"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/notify"

	"github.com/google/uuid"
)

type fixture struct {
	repo                *notify.Repository
	tenant, other       uuid.UUID
	alice, bob, outside uuid.UUID // alice: role with "cron" via belongs; bob: no category; outside: other tenant
	cronRoleLink        uuid.UUID // role_notification_category row giving cron
}

func setup(t *testing.T) fixture {
	t.Helper()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "notify")
	ctx := context.Background()
	f := fixture{repo: notify.NewRepository(app.DB), tenant: uuid.New(), other: uuid.New(),
		alice: uuid.New(), bob: uuid.New(), outside: uuid.New()}
	t.Cleanup(func() {
		for _, table := range []string{"notification_read", "notification", "role_notification_category",
			"notification_category", "role_belongs", "user_roles", "roles", "users"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = ANY($1)`, []uuid.UUID{f.tenant, f.other})
		}
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := app.DB.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	for _, u := range []struct{ id, tenant uuid.UUID }{{f.alice, f.tenant}, {f.bob, f.tenant}, {f.outside, f.other}} {
		exec(`INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`, u.id, u.tenant, uuid.NewString()+"@t.example")
	}
	// alice -> "ops" role, which belongs to "watchers"; "watchers" holds cron.
	ops, watchers, cat := uuid.New(), uuid.New(), uuid.New()
	f.cronRoleLink = uuid.New()
	exec(`INSERT INTO roles (id, tenant_id, name) VALUES ($1, $3, 'Ops'), ($2, $3, 'Watchers')`, ops, watchers, f.tenant)
	exec(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, f.tenant, f.alice, ops)
	exec(`INSERT INTO role_belongs (tenant_id, role_id, belongs_to_role_id) VALUES ($1, $2, $3)`, f.tenant, ops, watchers)
	exec(`INSERT INTO notification_category (id, tenant_id, key, label, name) VALUES ($1, $2, 'cron', 'Scheduled actions', 'Scheduled actions')`, cat, f.tenant)
	exec(`INSERT INTO role_notification_category (id, tenant_id, role_id, notification_category_id) VALUES ($1, $2, $3, $4)`, f.cronRoleLink, f.tenant, watchers, cat)
	return f
}

func create(t *testing.T, f fixture, tenant uuid.UUID, owner *uuid.UUID, category string) notify.Notification {
	t.Helper()
	n, err := f.repo.Create(context.Background(), notify.Notification{
		TenantID: tenant, UserID: owner, Category: category,
		Kind: "message", Title: "t", Link: "/x",
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func ids(items []notify.FeedItem) map[uuid.UUID]bool {
	out := map[uuid.UUID]bool{}
	for _, it := range items {
		out[it.ID] = true
	}
	return out
}

func TestFeed_PrivacyAndCategories(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	alicePersonal := create(t, f, f.tenant, &f.alice, "dev_seed")
	bobPersonal := create(t, f, f.tenant, &f.bob, "dev_seed")
	cronGlobal := create(t, f, f.tenant, nil, "cron")
	seedGlobal := create(t, f, f.tenant, nil, "dev_seed")
	otherTenantGlobal := create(t, f, f.other, nil, "cron")

	tests := []struct {
		name     string
		tenant   uuid.UUID
		user     uuid.UUID
		visible  []uuid.UUID
		excluded []uuid.UUID
	}{
		{"alice sees her own and cron globals (inherited via belongs)", f.tenant, f.alice,
			[]uuid.UUID{alicePersonal.ID, cronGlobal.ID},
			[]uuid.UUID{bobPersonal.ID, seedGlobal.ID, otherTenantGlobal.ID}},
		{"bob sees only his own", f.tenant, f.bob,
			[]uuid.UUID{bobPersonal.ID},
			[]uuid.UUID{alicePersonal.ID, cronGlobal.ID, seedGlobal.ID, otherTenantGlobal.ID}},
		{"another tenant sees nothing of this one", f.other, f.outside,
			nil,
			[]uuid.UUID{alicePersonal.ID, bobPersonal.ID, cronGlobal.ID, seedGlobal.ID, otherTenantGlobal.ID}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			items, unread, err := f.repo.Feed(ctx, tc.tenant, tc.user)
			if err != nil {
				t.Fatal(err)
			}
			got := ids(items)
			for _, id := range tc.visible {
				if !got[id] {
					t.Errorf("missing %s", id)
				}
			}
			for _, id := range tc.excluded {
				if got[id] {
					t.Errorf("leaked %s", id)
				}
			}
			if unread != len(tc.visible) {
				t.Errorf("unread = %d, want %d", unread, len(tc.visible))
			}
		})
	}
}

func TestMarkRead_OnlyVisibleRows(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	alicePersonal := create(t, f, f.tenant, &f.alice, "dev_seed")
	bobPersonal := create(t, f, f.tenant, &f.bob, "dev_seed")

	// Bob tries to mark Alice's personal notification read: silently ignored.
	marked, err := f.repo.MarkRead(ctx, f.tenant, f.bob, []uuid.UUID{alicePersonal.ID, bobPersonal.ID}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(marked) != 1 || marked[0] != bobPersonal.ID {
		t.Fatalf("marked = %v, want only bob's own", marked)
	}
	items, unread, _ := f.repo.Feed(ctx, f.tenant, f.alice)
	if unread != 1 || items[0].Read {
		t.Errorf("alice's notification must stay unread for her, unread=%d", unread)
	}
	// "all" marks only what the caller can see.
	if _, err := f.repo.MarkRead(ctx, f.tenant, f.alice, nil, true); err != nil {
		t.Fatal(err)
	}
	if _, unread, _ := f.repo.Feed(ctx, f.tenant, f.alice); unread != 0 {
		t.Errorf("alice unread after all = %d", unread)
	}
	if _, unread, _ := f.repo.Feed(ctx, f.tenant, f.bob); unread != 0 {
		t.Errorf("bob unread = %d (his was already read)", unread)
	}
}

func TestAudience_FollowsRoleChanges(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	got, err := f.repo.Audience(ctx, f.tenant, "cron")
	if err != nil || len(got) != 1 || got[0] != f.alice {
		t.Fatalf("audience = %v, %v; want [alice]", got, err)
	}
	if aud, _ := f.repo.Audience(ctx, f.tenant, "dev_seed"); len(aud) != 0 {
		t.Errorf("dev_seed audience = %v, want none", aud)
	}
	// Removing the category from the role takes effect on the next publish.
	if _, err := f.repo.DB().Exec(ctx, `UPDATE role_notification_category SET deleted_at = now() WHERE id = $1`, f.cronRoleLink); err != nil {
		t.Fatal(err)
	}
	if aud, _ := f.repo.Audience(ctx, f.tenant, "cron"); len(aud) != 0 {
		t.Errorf("audience after removal = %v, want none", aud)
	}
}

func TestSweepAndFailInterrupted(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	running, done := "running", "done"
	old := time.Now().Add(-40 * 24 * time.Hour)
	mk := func(owner *uuid.UUID, status *string, finished *time.Time) uuid.UUID {
		n, err := f.repo.Create(ctx, notify.Notification{TenantID: f.tenant,
			UserID: owner, Category: "cron", Kind: "activity", Title: "t", Link: "/x", Status: status, FinishedAt: finished})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.repo.DB().Exec(ctx, `UPDATE notification SET created_at = $2 WHERE id = $1`, n.ID, old); err != nil {
			t.Fatal(err)
		}
		return n.ID
	}
	oldGlobalDone := mk(nil, &done, &old)
	oldRunning := mk(nil, &running, nil)
	oldPersonal := mk(&f.alice, nil, nil)
	recentPersonal := create(t, f, f.tenant, &f.alice, "cron").ID

	if _, err := f.repo.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	exists := func(id uuid.UUID) bool {
		var n int
		_ = f.repo.DB().QueryRow(ctx, `SELECT count(*) FROM notification WHERE id = $1`, id).Scan(&n)
		return n == 1
	}
	if exists(oldGlobalDone) || exists(oldPersonal) {
		t.Error("expired rows must be swept")
	}
	if !exists(oldRunning) || !exists(recentPersonal) {
		t.Error("running and recent rows must stay")
	}
	// Scoped to rows older than its own (40 days back): never another test's or a live server's.
	if n, err := f.repo.FailInterrupted(ctx, old.Add(time.Minute)); err != nil || n < 1 {
		t.Fatalf("FailInterrupted = %d, %v", n, err)
	}
	var status string
	_ = f.repo.DB().QueryRow(ctx, `SELECT status FROM notification WHERE id = $1`, oldRunning).Scan(&status)
	if status != "failed" {
		t.Errorf("interrupted status = %q, want failed", status)
	}
}

// The person who started an activity always follows it — even without its
// category (seeding needs dev_seed:dev_seed:write, not the category) — or
// their own seed's progress page would spin forever.
func TestFeed_InitiatorSeesOwnActivity(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	running := "running"
	n, err := f.repo.Create(ctx, notify.Notification{TenantID: f.tenant,
		Category: "dev_seed", Kind: "activity", Title: "Seeding", Link: "/settings/developer", Status: &running, ActorID: &f.bob})
	if err != nil {
		t.Fatal(err)
	}
	items, _, _ := f.repo.Feed(ctx, f.tenant, f.bob)
	if !ids(items)[n.ID] {
		t.Error("bob started the activity but can't see it")
	}
	if marked, _ := f.repo.MarkRead(ctx, f.tenant, f.bob, []uuid.UUID{n.ID}, false); len(marked) != 1 {
		t.Errorf("bob can't mark his own activity read: %v", marked)
	}
	if items, _, _ := f.repo.Feed(ctx, f.tenant, f.alice); ids(items)[n.ID] {
		t.Error("alice (no dev_seed category, not the actor) must not see it")
	}
}
