package dbmanage

import (
	"context"
	"fmt"

	"core/internal/common"
	"core/orm"
)

// CreateAndProvision creates an empty database and immediately makes it a
// usable EERP database (every module's tables + a loggable-into default
// admin) — "just initialized to run on eerp", the feature's own requirement.
// Opens a throwaway *orm.App/pool purely for provisioning and closes it
// again; the caller decides separately (a later, explicit switch call)
// whether to actually start serving from it.
func (m *Manager) CreateAndProvision(ctx context.Context, name string) error {
	if err := CreateDatabase(ctx, m.conn, name); err != nil {
		return err
	}

	tmp, err := orm.New(orm.Config{DSN: m.conn.dsn(name)}, common.Logger)
	if err != nil {
		return fmt.Errorf("dbmanage: connect to new database %s: %w", name, err)
	}
	defer func() { _ = tmp.Close() }()

	return m.provisioner.Provision(ctx, tmp.DB)
}
