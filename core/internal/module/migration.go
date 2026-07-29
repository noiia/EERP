package module

import (
	"context"
	"fmt"

	"go.uber.org/zap"

	"core/internal/common"
	"core/internal/types"
	"core/orm"
)

func bootstrapMigrationsTable(ctx context.Context, db *orm.DB) error {
	_, err := db.Exec(ctx, `CREATE TABLE IF NOT EXISTS module_migrations (
		module_name TEXT    NOT NULL,
		version     INTEGER NOT NULL,
		applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (module_name, version)
	)`)
	return err
}

// opLog is nilable: boot-time callers pass nil (today's zap-only behavior);
// Registry.Reload passes a real *OpLogger so a live reload's DB-side steps
// (table/column/index DDL, migration-version bookkeeping) are queryable
// through the App Store's Logs wizard, tagged source "db".
func applyMigration(ctx context.Context, db *orm.DB, module string, m types.Migration, opLog *OpLogger) error {
	// Ensure every referenced table exists with BaseModel columns before
	// running column additions — ALTER TABLE fails if the table is absent.
	seen := map[string]struct{}{}
	for _, op := range m.Operations {
		if _, ok := seen[op.Table]; ok {
			continue
		}
		seen[op.Table] = struct{}{}
		if err := ensureTable(ctx, db, op.Table); err != nil {
			return fmt.Errorf("ensure table %s: %w", op.Table, err)
		}
		opLog.Log("db", "info", fmt.Sprintf("ensured table %s", op.Table))
	}

	var exists bool
	if err := db.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM module_migrations WHERE module_name=$1 AND version=$2)",
		module, m.Version,
	).Scan(&exists); err != nil {
		return err
	}

	if exists {
		common.Logger.Warn("↪️ migration already applied:", zap.String("module : ", module), zap.Int("version : ", m.Version))
		opLog.Log("db", "info", fmt.Sprintf("migration version %d already applied — skipped", m.Version))
		return nil
	}

	for _, op := range m.Operations {
		switch op.Type {
		case "add_column":
			sql := fmt.Sprintf(
				"ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
				op.Table,
				op.Column,
				op.SQLType,
			)
			common.Logger.Debug("🛠️", zap.String("", sql))
			if _, err := db.Exec(ctx, sql); err != nil {
				return err
			}
			opLog.Log("db", "info", sql)
			if op.Index {
				if err := createIndex(ctx, db, op); err != nil {
					return err
				}
				opLog.Log("db", "info", fmt.Sprintf("created index on %s(%s)", op.Table, op.Column))
			}
		case "create_index":
			if err := createIndex(ctx, db, op); err != nil {
				return err
			}
			opLog.Log("db", "info", fmt.Sprintf("created index on %s(%s)", op.Table, op.Column))
		}
	}

	_, err := db.Exec(ctx,
		"INSERT INTO module_migrations (module_name, version) VALUES ($1, $2)",
		module, m.Version,
	)
	common.Logger.Info("✅ Migration applied:", zap.String("module : ", module), zap.Int("version : ", m.Version))
	opLog.Log("db", "info", fmt.Sprintf("migration version %d recorded", m.Version))
	return err
}

// createIndex creates a single secondary index from a migration Operation.
// Idempotent via IF NOT EXISTS; index name is deterministic.
func createIndex(ctx context.Context, db orm.Executor, op types.Operation) error {
	method := op.IndexType
	if method == "" {
		method = "btree"
	}
	name := fmt.Sprintf("idx_%s_%s", op.Table, op.Column)
	// #nosec G201 — table/column/method come from module manifests, not user input.
	sql := fmt.Sprintf("CREATE INDEX IF NOT EXISTS %s ON %s USING %s (%s)",
		name, op.Table, method, op.Column)
	common.Logger.Debug("🛠️", zap.String("", sql))
	if _, err := db.Exec(ctx, sql); err != nil {
		return fmt.Errorf("create index %s: %w", name, err)
	}
	return nil
}

// ensureTable creates the table with BaseModel columns if it does not exist.
// Module-specific columns are added separately via ALTER TABLE ADD COLUMN.
func ensureTable(ctx context.Context, db orm.Executor, table string) error {
	// #nosec G201 — table names come from module manifests, not user input.
	_, err := db.Exec(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at TIMESTAMPTZ
		)`, table))
	return err
}

// baseModelColumns are created by ensureTable; skip them in autoMigrateTable.
var baseModelColumns = map[string]bool{
	"id": true, "created_at": true, "updated_at": true, "deleted_at": true,
}

// autoMigrateTable ensures the table exists, adds any missing columns, and
// creates any declared indexes.
func autoMigrateTable(ctx context.Context, db orm.Executor, table string, fields []orm.MigrationField) error {
	if err := ensureTable(ctx, db, table); err != nil {
		return err
	}
	if err := ensureColumns(ctx, db, table, fields); err != nil {
		return err
	}
	return ensureIndexes(ctx, db, table, fields)
}

// ensureColumns issues ALTER TABLE ADD COLUMN IF NOT EXISTS for each field
// that is not a BaseModel column. Idempotent — safe to call on extension.
func ensureColumns(ctx context.Context, db orm.Executor, table string, fields []orm.MigrationField) error {
	for _, f := range fields {
		if baseModelColumns[f.Column] {
			continue
		}
		notNull := ""
		if !f.Nullable && !f.IsPK {
			notNull = " NOT NULL"
		}
		// #nosec G201 — table/column names come from module manifests, not user input.
		sql := fmt.Sprintf("ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s%s",
			table, f.Column, f.SQLType, notNull)
		if _, err := db.Exec(ctx, sql); err != nil {
			return fmt.Errorf("add column %s: %w", f.Column, err)
		}
	}
	return nil
}

// ensureIndexes creates a secondary index for each field tagged db:"col,index".
// Index names are deterministic (idx_<table>_<column>) and creation is
// idempotent via IF NOT EXISTS, so this is safe to run on every startup.
func ensureIndexes(ctx context.Context, db orm.Executor, table string, fields []orm.MigrationField) error {
	for _, f := range fields {
		if !f.Index {
			continue
		}
		method := f.IndexType
		if method == "" {
			method = "btree"
		}
		name := fmt.Sprintf("idx_%s_%s", table, f.Column)
		// #nosec G201 — table/column/method come from struct tags, not user input.
		sql := fmt.Sprintf("CREATE INDEX IF NOT EXISTS %s ON %s USING %s (%s)",
			name, table, method, f.Column)
		if _, err := db.Exec(ctx, sql); err != nil {
			return fmt.Errorf("create index %s: %w", name, err)
		}
	}
	return nil
}
