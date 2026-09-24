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

// loadGoModule runs one Go module's Register() plus column-level
// auto-migration, returning the names of tables it NEWLY CREATED (as opposed
// to tables it merely extended with ExtendSchema, e.g. crminheritdemo adding
// columns to crm's table). Registry uses this to attribute table ownership
// for the runtime active-gate (runtime.go) — a table's owner is whichever
// module's Register() call is what created it, not every module that ever
// added a column to it.
func loadGoModule(ctx context.Context, db *orm.DB, m GoModule, ensuredThisBoot map[string]bool) ([]string, error) {
	// Column-level snapshot before Register() so we detect both new tables
	// AND new columns added to existing tables by ExtendSchema.
	before := columnSnapshot()

	if err := m.Register(); err != nil {
		return nil, fmt.Errorf("module %s: register: %w", m.Name(), err)
	}

	var newTables []string
	for tableName, afterCols := range columnSnapshot() {
		prevCols := before[tableName]

		// isNewTable is Go-side bookkeeping ONLY (table-ownership attribution,
		// below) — it must NOT gate whether the DDL below runs. columnSnapshot
		// diffs a process-global, in-memory registry, not real database state:
		// on a second Boot() in the same process (module.Registry re-Boot after
		// core/internal/dbmanage swaps the live pgxpool to a different — possibly
		// completely empty — database), every table this process has ever seen
		// already shows up in "before", so a diff-gated ensureTable/ensureColumns
		// would silently skip creating anything on the new database.
		isNewTable := afterCols != nil && prevCols == nil
		if isNewTable {
			newTables = append(newTables, tableName)
		}

		// ensuredThisBoot is scoped to ONE Boot() call (Registry.Boot creates it
		// fresh and threads it through every module) — it is what keeps this
		// unconditional-by-design pass from being O(n²). Without it, this loop
		// walks the ENTIRE global table registry on every one of n modules'
		// turns (columnSnapshot() returns every table registered so far, not
		// just this module's own), so module k redundantly re-issues
		// ensureTable/ensureColumns for all k-1 tables earlier modules in this
		// same Boot() already ensured — a real, measured cost: on an otherwise
		// empty target database (core/internal/dbmanage's SwitchTo), that's
		// purely redundant round trips, not a no-op skipped by IF NOT EXISTS
		// (the statement still has to be sent and answered). Ensuring a table
		// once per Boot() call is sufficient — a table is either handled in
		// its own module's turn (this branch) or was already handled by an
		// earlier module's turn in the SAME call, and IF NOT EXISTS still
		// makes each individual ensure idempotent within that one guaranteed
		// pass, same as before.
		if ensuredThisBoot[tableName] {
			continue
		}
		ensuredThisBoot[tableName] = true

		if err := ensureTable(ctx, db, tableName); err != nil {
			return newTables, fmt.Errorf("module %s: ensure table %s: %w", m.Name(), tableName, err)
		}
		allFields, _ := orm.MigrationFieldsForTable(tableName)
		if err := ensureColumns(ctx, db, tableName, allFields); err != nil {
			return newTables, fmt.Errorf("module %s: ensure columns %s: %w", m.Name(), tableName, err)
		}
	}

	// Optional extra DDL (join tables, constraints, etc.).
	if migrator, ok := m.(Migrator); ok {
		if err := migrator.Migrate(ctx, db); err != nil {
			return newTables, fmt.Errorf("module %s: migrate: %w", m.Name(), err)
		}
	}

	return newTables, nil
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
