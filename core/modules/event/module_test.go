package event

import (
	"context"
	"os"
	"testing"
	"time"

	"core/internal/common"
	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

func TestMain(m *testing.M) {
	if err := common.InitLogger(false); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func TestEvent_IsTenantScoped(t *testing.T) {
	if err := (&eventModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("event")
	if !ok {
		t.Fatal("event table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("event is missing tenant_id — tenant isolation would not apply")
}

// A pre-existing row violating a CHECK must not fail boot: constraints are
// added NOT VALID (enforced on new/updated rows only).
func TestMigrate_ToleratesViolatingRows(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "event")
	ctx := context.Background()
	tenant := uuid.New()
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, `DELETE FROM event_session WHERE tenant_id = $1`, tenant) })
	if _, err := app.DB.Exec(ctx, `ALTER TABLE event_session DROP CONSTRAINT IF EXISTS event_session_window`); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := app.DB.Exec(ctx, `INSERT INTO event_session (tenant_id, event_id, starts_at, ends_at, capacity, seats_taken)
		VALUES ($1, $2, $3, $4, 1, 0)`, tenant, uuid.New(), now, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := (&eventModule{}).Migrate(ctx, app.DB); err != nil {
		t.Fatalf("Migrate with a violating row: %v", err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO event_session (tenant_id, event_id, starts_at, ends_at, capacity, seats_taken)
		VALUES ($1, $2, $3, $4, 1, 0)`, tenant, uuid.New(), now, now.Add(-time.Hour)); err == nil {
		t.Fatal("a new inverted session was accepted: constraint not enforced")
	}
}
