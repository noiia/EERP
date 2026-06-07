package module

import (
	"context"
	"fmt"
	"sync"

	"core/orm"
)

// GoModule is the interface every pure-Go module must implement.
// Register() calls orm.Register[T]() for new tables, or orm.ExtendSchema()
// for tables owned by another module. Migration is derived automatically.
type GoModule interface {
	Name() string
	Register() error
}

// Migrator is an optional extension to GoModule.
// Implement it when your module needs DDL beyond what the auto-migration derives
// from registered structs — for example, join tables with composite PKs.
// Migrate is called after Register and the struct-level auto-migration.
type Migrator interface {
	Migrate(ctx context.Context, db *orm.DB) error
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
		// Column-level snapshot before Register() so we detect both new
		// tables AND new columns added to existing tables by ExtendSchema.
		before := columnSnapshot()

		if err := m.Register(); err != nil {
			errs = append(errs, fmt.Errorf("module %s: register: %w", m.Name(), err))
			continue
		}

		for tableName, afterCols := range columnSnapshot() {
			prevCols := before[tableName]

			// Collect only the columns that are new since before Register().
			var newFields []orm.MigrationField
			allFields, _ := orm.MigrationFieldsForTable(tableName)
			for _, f := range allFields {
				if !prevCols[f.Column] {
					newFields = append(newFields, f)
				}
			}
			if len(newFields) == 0 {
				continue
			}

			// New table: create it with BaseModel columns first.
			if afterCols != nil && prevCols == nil {
				if err := ensureTable(ctx, db, tableName); err != nil {
					errs = append(errs, fmt.Errorf("module %s: ensure table %s: %w", m.Name(), tableName, err))
					continue
				}
			}

			// Add the new columns (idempotent, IF NOT EXISTS).
			if err := ensureColumns(ctx, db, tableName, newFields); err != nil {
				errs = append(errs, fmt.Errorf("module %s: ensure columns %s: %w", m.Name(), tableName, err))
			}
		}

		// Optional extra DDL (join tables, constraints, etc.).
		if migrator, ok := m.(Migrator); ok {
			if err := migrator.Migrate(ctx, db); err != nil {
				errs = append(errs, fmt.Errorf("module %s: migrate: %w", m.Name(), err))
			}
		}
	}
	return errs
}

// columnSnapshot captures the current set of column names per registered table.
// Comparing two snapshots reveals both new tables and new columns on existing ones.
func columnSnapshot() map[string]map[string]bool {
	snap := make(map[string]map[string]bool)
	for _, name := range orm.RegisteredTableNames() {
		fields, ok := orm.MigrationFieldsForTable(name)
		if !ok {
			continue
		}
		cols := make(map[string]bool, len(fields))
		for _, f := range fields {
			cols[f.Column] = true
		}
		snap[name] = cols
	}
	return snap
}
