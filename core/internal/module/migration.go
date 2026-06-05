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

func applyMigration(ctx context.Context, db *orm.DB, module string, m types.Migration) error {
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
		return nil
	}

	for _, op := range m.Operations {
		if op.Type == "add_column" {
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
		}
	}

	_, err := db.Exec(ctx,
		"INSERT INTO module_migrations (module_name, version) VALUES ($1, $2)",
		module, m.Version,
	)
	common.Logger.Info("✅ Migration applied:", zap.String("module : ", module), zap.Int("version : ", m.Version))
	return err
}

// ensureTable creates the table with BaseModel columns if it does not exist.
// Module-specific columns are added separately via ALTER TABLE ADD COLUMN.
func ensureTable(ctx context.Context, db *orm.DB, table string) error {
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

// autoMigrateTable ensures the table exists and adds any missing columns,
// derived automatically from the struct's ORM metadata. Idempotent.
func autoMigrateTable(ctx context.Context, db *orm.DB, table string, fields []orm.MigrationField) error {
	if err := ensureTable(ctx, db, table); err != nil {
		return err
	}
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
