package module

import (
	"context"

	"core/orm"
)

// GoModuleCount exposes the internal goModules slice length for white-box tests.
func GoModuleCount() int {
	goMu.Lock()
	defer goMu.Unlock()
	return len(goModules)
}

// RegisterSchemaOnly calls m.Register() for every enlisted Go module
// without touching the DB. Used in unit tests to verify schema registration
// without a live Postgres connection.
func RegisterSchemaOnly() []error {
	goMu.Lock()
	mods := make([]GoModule, len(goModules))
	copy(mods, goModules)
	goMu.Unlock()

	var errs []error
	for _, m := range mods {
		if err := m.Register(); err != nil {
			errs = append(errs, err)
		}
	}
	return errs
}

// LoadGoModule exposes loadGoModule so a test can drive one Boot()'s module
// sequence (a shared ensured map) against a real database.
func LoadGoModule(ctx context.Context, db *orm.DB, m GoModule, ensured map[string]int) ([]string, error) {
	return loadGoModule(ctx, db, m, ensured)
}
