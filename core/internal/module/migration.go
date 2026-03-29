package module

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"core/internal/common"
	"core/internal/types"
)

func applyMigration(ctx context.Context, conn *pgx.Conn, module string, m types.Migration) error {
	var exists bool

	err := conn.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM module_migrations WHERE module_name=$1 AND version=$2)",
		module, m.Version,
	).Scan(&exists)
	if err != nil {
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
			if _, err := conn.Exec(ctx, sql); err != nil {
				return err
			}
		}
	}

	_, err = conn.Exec(ctx,
		"INSERT INTO module_migrations (module_name, version) VALUES ($1, $2)",
		module, m.Version,
	)

	common.Logger.Info("✅ Migration applied:", zap.String("module : ", module), zap.Int("version : ", m.Version))
	return err
}
