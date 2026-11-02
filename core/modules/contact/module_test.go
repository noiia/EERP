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

// A website signup's contact carries the account's person data, and the new
// columns exist on the table (address names equal the users table's).
func TestCreateWebsiteContact_CopiesPersonAndAddress(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "contact")
	tenant := uuid.New()
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, `DELETE FROM contact WHERE tenant_id = $1`, tenant) })

	id, err := CreateWebsiteContact(ctx, app.DB, tenant, WebsiteContact{
		Name: "Ann", Surname: "Lee", Email: "ann@x.test", Phone: "+33 1 23"})
	if err != nil {
		t.Fatal(err)
	}
	var name, email string
	var surname, phone, street *string
	var number *int
	if err := app.DB.QueryRow(ctx, `SELECT name, email, surname, phone, address_street, address_number FROM contact WHERE id = $1`, id).
		Scan(&name, &email, &surname, &phone, &street, &number); err != nil {
		t.Fatal(err)
	}
	if name != "Ann" || email != "ann@x.test" || surname == nil || *surname != "Lee" || phone == nil || *phone != "+33 1 23" || street != nil || number != nil {
		t.Errorf("got %q %q %v %v %v %v", name, email, surname, phone, street, number)
	}

	// Empty surname/phone are stored as NULL.
	id2, err := CreateWebsiteContact(ctx, app.DB, tenant, WebsiteContact{Name: "Bob", Email: "bob@x.test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.DB.QueryRow(ctx, `SELECT surname, phone FROM contact WHERE id = $1`, id2).Scan(&surname, &phone); err != nil {
		t.Fatal(err)
	}
	if surname != nil || phone != nil {
		t.Errorf("empty surname/phone should be NULL, got %v %v", surname, phone)
	}

	// Address columns round-trip.
	if _, err := app.DB.Exec(ctx, `UPDATE contact SET address_number = 4, address_complement = 'b', address_street = 'Rue X', address_zip_code = '31000', address_city = 'Toulouse', address_state = 'Occ', address_country = 'FR' WHERE id = $1`, id); err != nil {
		t.Fatalf("address columns: %v", err)
	}
}
