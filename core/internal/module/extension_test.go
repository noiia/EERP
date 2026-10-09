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
}
