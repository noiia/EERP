package dbmanage

import (
	"context"
	"time"
)

// CreateAndProvision creates an empty database and immediately makes it a
// usable, activate-ready EERP database (every module's tables + a
// loggable-into default admin) — "just initialized to run on eerp", the
// feature's own requirement. Shares provisionAndKeepWarm with Prepare
// (prepare.go): the resulting pool is kept warm and recorded as a ready
// standby rather than closed, so a freshly created database needs no
// separate Prepare call before the caller can Activate it.
func (m *Manager) CreateAndProvision(ctx context.Context, name string) error {
	if err := CreateDatabase(ctx, m.conn, name); err != nil {
		return err
	}
	return m.provisionAndKeepWarm(ctx, name, time.Now())
}
