package company_test

import (
	"context"
	"sync"
	"testing"

	"core/internal/company"
	"core/internal/testdb"
	_ "core/modules/auth"    // registers the auth module (users) for testdb.MigrateModules
	_ "core/modules/company" // registers the company module
	"core/orm"

	"github.com/google/uuid"
)

// integrationSetup connects to the test DB (internal/testdb) and ensures the tables this package
// needs exist. It NEVER deletes existing rows — this runs against a shared,
// possibly non-empty database (e.g. a live dev stack), not a disposable one.
// Every test seeds its OWN throwaway tenant/user and cleans up ONLY the rows
// it created, scoped by id/tenant_id — never a blanket DELETE FROM <table>.
func integrationSetup(t *testing.T) *orm.App {
	t.Helper()
	app := testdb.Open(t)

	// The real company + users schema, as boot creates it.
	testdb.MigrateModules(t, app, "auth", "company")

	return app
}

// seedUser creates a throwaway user for tenantID and registers cleanup
// scoped to exactly that row and exactly this tenant's company rows —
// never a table-wide delete (this may run against a shared, non-empty
// database).
func seedUser(t *testing.T, db *orm.DB, tenantID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := db.QueryRow(ctx,
		`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, 'multicompany-test@example.invalid', 'x') RETURNING id`,
		tenantID,
	).Scan(&id); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		db.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)                //nolint:errcheck
		db.Exec(ctx, `DELETE FROM company WHERE tenant_id = $1`, tenantID) //nolint:errcheck
	})
	return id
}

// TestResolveActive_Bootstrap_ConcurrentFirstTouch proves the race-safety
// argument documented on Repository.EnsureDefaultCompany/ResolveActive: two
// simultaneous first-touch requests for a brand-new tenant/user must
// converge on exactly ONE default company, never two.
func TestResolveActive_Bootstrap_ConcurrentFirstTouch(t *testing.T) {
	app := integrationSetup(t)
	repo := company.NewRepository(app.DB)

	tenantID := uuid.New()
	userID := seedUser(t, app.DB, tenantID)

	const n = 20
	var wg sync.WaitGroup
	results := make([]company.Company, n)
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = repo.ResolveActive(context.Background(), tenantID, userID)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: ResolveActive: %v", i, err)
		}
	}

	first := results[0].ID
	for i, c := range results {
		if c.ID != first {
			t.Errorf("goroutine %d resolved company %s, want %s (every concurrent first-touch must converge on the same company)", i, c.ID, first)
		}
	}

	var count int
	if err := app.DB.QueryRow(context.Background(),
		`SELECT count(*) FROM company WHERE tenant_id = $1 AND is_default`, tenantID,
	).Scan(&count); err != nil {
		t.Fatalf("count default companies: %v", err)
	}
	if count != 1 {
		t.Errorf("default company count = %d, want exactly 1", count)
	}
}
