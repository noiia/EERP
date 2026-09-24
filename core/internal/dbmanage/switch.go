package dbmanage

import (
	"context"
	"fmt"
	"time"

	"core/internal/auth"
	"core/internal/common"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// oldPoolGrace is how long a just-replaced pool is kept open after SwapPool
// before Close() — long enough for any request that grabbed a reference to
// it a moment before the swap to finish, short enough that this is not a
// real resource concern.
const oldPoolGrace = 5 * time.Second

// SwitchTo hot-swaps the ENTIRE running instance onto a different database —
// no restart. Every Repository[T]/handler/background ticker already
// referencing m.app.DB picks up the new pool automatically the moment
// SwapPool returns (core/orm/pool/db.DB.SwapPool's own doc comment); the
// steps around that swap are what make the result actually correct rather
// than just "pointed at different bytes":
//
//  1. Re-run THIS process's live module.Registry.Boot — not a throwaway one —
//     so schema gets provisioned if name is a fresh/empty database (safe to
//     call repeatedly, see the go_module.go fix) AND so the registry's own
//     active/table-ownership state (ActiveGateMiddleware's source of truth)
//     is recomputed against whatever module.json currently says, same as any
//     normal boot.
//  2. Seed the default admin if missing, so a freshly-created target is
//     immediately loggable-into.
//  3. Force-disconnect every presence websocket — those sockets represent
//     sessions authenticated against the OLD database; letting them linger
//     would keep broadcasting/receiving as if nothing changed.
//  4. Persist db_name into the on-disk config (temp file + rename, the same
//     pattern internal/module's module.json PUT already uses) so the switch
//     survives a future restart instead of silently reverting.
//
// Every current session's JWT is NOT explicitly invalidated — it doesn't
// need to be. A session's access-token claims resolve against whichever
// database is live at request time; once this returns, that's `name`, so an
// old session's user id either 401s (not found) or, in the ordinary case,
// simply stops matching real data — the existing 401-then-redirect-to-/login
// handling (core-front's ApiClient) already covers this with no new code.
func (m *Manager) SwitchTo(ctx context.Context, name string) error {
	if err := validateName(name); err != nil {
		return err
	}

	newPool, err := pgxpool.New(ctx, m.conn.dsn(name))
	if err != nil {
		return fmt.Errorf("dbmanage: open pool for %s: %w", name, err)
	}
	if err := newPool.Ping(ctx); err != nil {
		newPool.Close()
		return fmt.Errorf("dbmanage: ping %s: %w", name, err)
	}

	// The swap itself is irreversible the instant it returns — the new pool is
	// already live and serving traffic — so the old pool must be scheduled for
	// cleanup unconditionally from here on, EVEN if a later step (Boot/
	// SeedDevAdmin) fails and this function returns early. A bare call at the
	// bottom of the function (only reached on the success path) leaked the old
	// pool's connections forever on any such failure — caught by this feature's
	// own end-to-end testing (a failed switch left idle connections in
	// pg_stat_activity with no process left holding a reference to close them).
	oldPool := m.app.DB.SwapPool(newPool)
	defer time.AfterFunc(oldPoolGrace, oldPool.Close)

	if errs := m.moduleRuntime.Boot(ctx); len(errs) > 0 {
		return fmt.Errorf("dbmanage: provision schema on %s: %w", name, errs[0])
	}
	if err := auth.SeedDevAdmin(ctx, m.app.DB, m.environment); err != nil {
		return fmt.Errorf("dbmanage: seed default admin on %s: %w", name, err)
	}

	m.presenceHub.CloseAll()

	if err := persistDBName(m.configPath, name); err != nil {
		// The live switch already succeeded — a failure to persist means a
		// future restart would revert to the old db_name, not that anything
		// is broken right now. Log loudly rather than fail the request.
		common.Logger.Error("dbmanage: switch succeeded live but failed to persist db_name",
			zap.String("db", name), zap.Error(err))
	}

	m.setActiveName(name)
	return nil
}
