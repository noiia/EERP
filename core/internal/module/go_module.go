package module

import (
	"context"
	"fmt"
	"sync"

	"core/orm"
)

// GoModule is the interface every pure-Go module must implement.
// Register() calls orm.Register[T]() for each model the module owns.
// Migration is derived automatically from the struct's db tags — no manual
// operations list is needed.
type GoModule interface {
	Name() string
	Register() error
}

var (
	goMu      sync.Mutex
	goModules []GoModule
)

// RegisterGoModule enlists a Go module. Call from package init().
func RegisterGoModule(m GoModule) {
	goMu.Lock()
	goModules = append(goModules, m)
	goMu.Unlock()
}

// LoadGoModules applies migrations and registers ORM schemas for every
// Go module that called RegisterGoModule. Call once after the DB is up,
// before building HTTP handlers.
func LoadGoModules(ctx context.Context, db *orm.DB) []error {
	goMu.Lock()
	mods := make([]GoModule, len(goModules))
	copy(mods, goModules)
	goMu.Unlock()

	var errs []error
	for _, m := range mods {
		before := tableSet(orm.RegisteredTableNames())

		if err := m.Register(); err != nil {
			errs = append(errs, fmt.Errorf("module %s: register: %w", m.Name(), err))
			continue
		}

		for _, tableName := range orm.RegisteredTableNames() {
			if before[tableName] {
				continue
			}
			fields, ok := orm.MigrationFieldsForTable(tableName)
			if !ok {
				continue
			}
			if err := autoMigrateTable(ctx, db, tableName, fields); err != nil {
				errs = append(errs, fmt.Errorf("module %s: auto-migrate %s: %w", m.Name(), tableName, err))
			}
		}
	}
	return errs
}

func tableSet(names []string) map[string]bool {
	s := make(map[string]bool, len(names))
	for _, n := range names {
		s[n] = true
	}
	return s
}
