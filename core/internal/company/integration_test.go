package company_test

import (
	"context"
	"reflect"
	"strings"
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

func TestBackfillCompanyID(t *testing.T) {
	app := integrationSetup(t)
	repo := company.NewRepository(app.DB)
	ctx := context.Background()

	// A throwaway table shaped like app_settings/report_page_format.
	table := "backfill_probe_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	if _, err := app.DB.Exec(ctx, `CREATE TABLE `+table+` (tenant_id UUID NOT NULL, company_id UUID)`); err != nil {
		t.Fatalf("create probe table: %v", err)
	}
	withDefault, withoutDefault := uuid.New(), uuid.New()
	t.Cleanup(func() {
		app.DB.Exec(ctx, `DROP TABLE `+table)                                                                       //nolint:errcheck
		app.DB.Exec(ctx, `DELETE FROM company WHERE tenant_id = ANY($1)`, []uuid.UUID{withDefault, withoutDefault}) //nolint:errcheck
	})
	existing, err := repo.EnsureDefaultCompany(ctx, withDefault)
	if err != nil {
		t.Fatalf("ensure default: %v", err)
	}
	preset := uuid.New()
	if _, err := app.DB.Exec(ctx, `INSERT INTO `+table+` VALUES ($1, NULL), ($1, NULL), ($2, NULL), ($2, $3)`,
		withDefault, withoutDefault, preset); err != nil {
		t.Fatalf("seed probe rows: %v", err)
	}

	if err := repo.BackfillCompanyID(ctx, table); err != nil {
		t.Fatalf("BackfillCompanyID: %v", err)
	}
	created, err := repo.EnsureDefaultCompany(ctx, withoutDefault)
	if err != nil {
		t.Fatalf("read created default: %v", err)
	}

	tests := []struct {
		name   string
		tenant uuid.UUID
		want   []uuid.UUID
	}{
		{"tenant with a default reuses it", withDefault, []uuid.UUID{existing.ID, existing.ID}},
		{"tenant without one gets a new default; preset row untouched", withoutDefault, []uuid.UUID{created.ID, preset}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows, err := app.DB.Query(ctx, `SELECT company_id FROM `+table+` WHERE tenant_id = $1 ORDER BY company_id = $2 DESC`, tt.tenant, tt.want[0])
			if err != nil {
				t.Fatalf("read back: %v", err)
			}
			defer rows.Close()
			var got []uuid.UUID
			for rows.Next() {
				var id uuid.UUID
				if err := rows.Scan(&id); err != nil {
					t.Fatalf("scan: %v", err)
				}
				got = append(got, id)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("company_ids = %v, want %v", got, tt.want)
			}
		})
	}
}

// A NULL row whose key the default company already holds stays NULL instead of
// colliding with a unique (tenant_id, company_id, key) index and failing boot.
func TestBackfillCompanyID_SkipsTakenKeys(t *testing.T) {
	app := integrationSetup(t)
	repo := company.NewRepository(app.DB)
	ctx := context.Background()
	table := "backfill_keys_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	if _, err := app.DB.Exec(ctx, `CREATE TABLE `+table+` (tenant_id UUID NOT NULL, company_id UUID, key TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `CREATE UNIQUE INDEX ON `+table+` (tenant_id, company_id, key)`); err != nil {
		t.Fatal(err)
	}
	tenant := uuid.New()
	t.Cleanup(func() {
		app.DB.Exec(ctx, `DROP TABLE `+table)                                //nolint:errcheck
		app.DB.Exec(ctx, `DELETE FROM company WHERE tenant_id = $1`, tenant) //nolint:errcheck
	})
	def, err := repo.EnsureDefaultCompany(ctx, tenant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.DB.Exec(ctx, `INSERT INTO `+table+` VALUES ($1, $2, 'taken'), ($1, NULL, 'taken'), ($1, NULL, 'free')`, tenant, def.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.BackfillCompanyID(ctx, table, "key"); err != nil {
		t.Fatalf("BackfillCompanyID: %v", err)
	}
	var nullTaken, movedFree int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE key = 'taken' AND company_id IS NULL`).Scan(&nullTaken)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE key = 'free' AND company_id = $1`, def.ID).Scan(&movedFree)
	if nullTaken != 1 || movedFree != 1 {
		t.Errorf("taken row left NULL = %d (want 1), free row moved = %d (want 1)", nullTaken, movedFree)
	}
}
