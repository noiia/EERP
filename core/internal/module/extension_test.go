package module_test

import (
	"context"
	"testing"

	"core/internal/testdb"
)

// EnsureSchema (what testdb.Migrate and boot share) must leave PostGIS
// installed, so a fresh database — CI, a dbmanage-created one — can hold
// geography columns.
func TestEnsureSchema_CreatesPostGIS(t *testing.T) {
	app := testdb.Open(t)
	testdb.Migrate(t, app) // no tables: only the extension pass runs
	var version string
	if err := app.DB.QueryRow(context.Background(), `SELECT postgis_version()`).Scan(&version); err != nil {
		t.Fatalf("postgis not installed: %v", err)
	}
	// …and up to date with the server's PostGIS after an image upgrade.
	var stale int
	if err := app.DB.QueryRow(context.Background(), `SELECT count(*) FROM pg_available_extensions
		WHERE name LIKE 'postgis%' AND installed_version IS NOT NULL
		  AND installed_version <> default_version`).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if stale != 0 {
		t.Fatalf("%d postgis extension(s) left at an old version", stale)
	}
}
