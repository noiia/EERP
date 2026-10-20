package contact

import (
	"context"
	"testing"

	"core/internal/testdb"
	"core/orm"

	"github.com/google/uuid"
)

// The contact table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a). Without it,
// contacts would be global and readable across tenants.
func TestContact_IsTenantScoped(t *testing.T) {
	if err := (&contactModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("contact")
	if !ok {
		t.Fatal("contact table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("contact is missing tenant_id — tenant isolation would not apply")
}

// Migrate reads a contact from before kinds as a person, and links a
// (contact, company) pair at most once among live rows.
func TestMigrate_KindBackfillAndUniqueLink(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "contact")
	tenant := uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(ctx, `DELETE FROM contact_company WHERE tenant_id = $1`, tenant)
		_, _ = app.DB.Exec(ctx, `DELETE FROM contact WHERE tenant_id = $1`, tenant)
	})
	var person, company uuid.UUID
	if err := app.DB.QueryRow(ctx, `INSERT INTO contact (tenant_id, name, email) VALUES ($1, 'Ada', 'ada@x.test') RETURNING id`,
		tenant).Scan(&person); err != nil {
		t.Fatal(err)
	}
	if err := app.DB.QueryRow(ctx, `INSERT INTO contact (tenant_id, name, email, kind) VALUES ($1, 'Acme', '', 'company') RETURNING id`,
		tenant).Scan(&company); err != nil {
		t.Fatal(err)
	}
	if err := (&contactModule{}).Migrate(ctx, app.DB); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	kinds := map[uuid.UUID]string{}
	for _, id := range []uuid.UUID{person, company} {
		var k string
		if err := app.DB.QueryRow(ctx, `SELECT kind FROM contact WHERE id = $1`, id).Scan(&k); err != nil {
			t.Fatal(err)
		}
		kinds[id] = k
	}
	if kinds[person] != KindContact || kinds[company] != KindCompany {
		t.Errorf("kinds after migrate = %v, want the NULL one backfilled as contact and the company kept", kinds)
	}

	link := `INSERT INTO contact_company (tenant_id, contact_id, company_id) VALUES ($1, $2, $3)`
	if _, err := app.DB.Exec(ctx, link, tenant, person, company); err != nil {
		t.Fatalf("first link: %v", err)
	}
	if _, err := app.DB.Exec(ctx, link, tenant, person, company); err == nil {
		t.Error("a second live link of the same pair: want a unique violation")
	}
}
