package dbmanage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"core/internal/common"
	"core/orm"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// ErrNotReady is returned by Activate when name has no successful, still-warm
// Prepare behind it.
var ErrNotReady = errors.New("dbmanage: target is not ready to activate — prepare it first")

// PrepareStatus is one database's lifecycle relative to Manager.prepared.
// Entirely in-memory, never persisted: a core-back restart wipes it, which
// is deliberate rather than a gap — a restart is also exactly when new
// module code/migrations could exist, so forcing a fresh Prepare after one
// is correct, not just convenient (see Prepare's own doc comment).
type PrepareStatus string

const (
	StatusUnprepared PrepareStatus = "unprepared"
	StatusPreparing  PrepareStatus = "preparing"
	StatusReady      PrepareStatus = "ready"
	StatusFailed     PrepareStatus = "failed"
)

// preparedTarget is one database's standby state: either mid-Prepare, ready
// to Activate with a warm pool sitting behind it, or a failed attempt's
// error. Guarded by Manager.mu — the same lock ActiveName/setActiveName
// already use, since this is the same "what state is this Manager in"
// concern, not a separate one.
type preparedTarget struct {
	pool       *pgxpool.Pool
	preparing  bool
	ready      bool
	err        error
	preparedAt time.Time
}

// provisionAndKeepWarm opens a pool to name with the deployment's real pool
// sizing (m.maxConns/m.minConns — this pool may end up serving all
// production traffic via Activate's SwapPool, so it must NOT fall back to
// pgx's bare defaults the way the old CreateAndProvision/SwitchTo silently
// did), runs the same schema provisioning CreateAndProvision has always used
// (Provisioner.Provision — module.Registry.Boot + auth.SeedDevAdmin) against
// it, and — on success — keeps the pool open and warm instead of closing it,
// recording it as a ready preparedTarget. Shared by Prepare and
// CreateAndProvision, which differ only in whether they CREATE DATABASE
// first.
func (m *Manager) provisionAndKeepWarm(ctx context.Context, name string) error {
	tmp, err := orm.New(orm.Config{DSN: m.conn.dsn(name), MaxConns: m.maxConns, MinConns: m.minConns}, common.Logger)
	if err != nil {
		err = fmt.Errorf("dbmanage: connect to %s: %w", name, err)
		m.mu.Lock()
		m.prepared[name] = &preparedTarget{err: err}
		m.mu.Unlock()
		return err
	}

	if err := m.provisioner.Provision(ctx, tmp.DB); err != nil {
		tmp.Close() // don't leak a failed attempt's connections
		m.mu.Lock()
		m.prepared[name] = &preparedTarget{err: err}
		m.mu.Unlock()
		return err
	}

	m.mu.Lock()
	m.prepared[name] = &preparedTarget{pool: tmp.DB.Pool(), ready: true, preparedAt: time.Now()}
	m.mu.Unlock()
	return nil
}

// Prepare provisions name's schema against a NOT-yet-live connection — safe
// to run in the background (Handler.Prepare kicks it off in a goroutine)
// with zero impact on whatever database is currently serving traffic. It
// never touches m.app.DB or m.moduleRuntime: Provisioner.Provision builds
// its own throwaway module.Registry per call (provision.go's own doc
// comment), completely independent of the process's one live registry
// singleton — which is safe because that registry's active/table-ownership
// bookkeeping is derived purely from module_root's filesystem scan, never
// from which database happens to be live, so it never needed recomputing on
// a switch in the first place.
//
// Idempotent: already-preparing or already-ready is a silent no-op — a
// repeat Prepare of an unchanged target costs nothing, which is the whole
// point of decoupling this from Activate ("don't re-deploy the schema on
// every switch").
func (m *Manager) Prepare(ctx context.Context, name string) error {
	if err := validateName(name); err != nil {
		return err
	}

	m.mu.Lock()
	if t := m.prepared[name]; t != nil && (t.preparing || t.ready) {
		m.mu.Unlock()
		return nil
	}
	m.prepared[name] = &preparedTarget{preparing: true}
	m.mu.Unlock()

	return m.provisionAndKeepWarm(ctx, name)
}

// Activate is the fast path: swap the live pool onto name's already-warm,
// already-provisioned standby. No schema work happens here — that's the
// entire point of splitting this from Prepare. Requires a prior successful
// Prepare; returns ErrNotReady otherwise.
func (m *Manager) Activate(ctx context.Context, name string) error {
	if err := validateName(name); err != nil {
		return err
	}

	m.mu.Lock()
	target := m.prepared[name]
	m.mu.Unlock()

	if target == nil || !target.ready {
		return ErrNotReady
	}

	// SwapPool itself does zero validation (core/orm/pool/db.DB.SwapPool's own
	// doc comment) — a standby pool can sit warm for a long time between
	// Prepare and Activate, so a single cheap Ping right before the swap is
	// the only thing standing between "the connection quietly died while
	// idle" and silently activating the live app onto a dead pool.
	if err := target.pool.Ping(ctx); err != nil {
		m.mu.Lock()
		delete(m.prepared, name)
		m.mu.Unlock()
		target.pool.Close()
		return fmt.Errorf("dbmanage: prepared standby for %s went stale, re-prepare it: %w", name, err)
	}

	oldPool := m.app.DB.SwapPool(target.pool)
	oldName := m.ActiveName()

	m.presenceHub.CloseAll()

	if err := persistDBName(m.configPath, name); err != nil {
		// The live switch already succeeded — a failure to persist means a
		// future restart would revert to the old db_name, not that anything
		// is broken right now. Log loudly rather than fail the request.
		common.Logger.Error("dbmanage: activate succeeded live but failed to persist db_name",
			zap.String("db", name), zap.Error(err))
	}

	m.setActiveName(name)

	m.mu.Lock()
	// The just-deactivated pool becomes the new standby for oldName instead
	// of being closed — this is what makes toggling BACK to it later free:
	// no re-provisioning, no new connections, just another Ping + SwapPool.
	// (oldName == name only when re-activating the database that's already
	// live, a harmless no-op; nothing to keep in that case.)
	if oldName != "" && oldName != name {
		m.prepared[oldName] = &preparedTarget{pool: oldPool, ready: true, preparedAt: time.Now()}
	}
	delete(m.prepared, name) // live now, not a standby
	m.mu.Unlock()

	return nil
}

// Discard releases a prepared standby without activating it — closes its
// pool and forgets it. A no-op, not an error, when name isn't prepared, so
// Delete's own unconditional call to this (below) and an operator's explicit
// "never mind" both work the same way with no existence check needed first.
func (m *Manager) Discard(name string) {
	m.mu.Lock()
	target := m.prepared[name]
	delete(m.prepared, name)
	m.mu.Unlock()

	if target != nil && target.pool != nil {
		target.pool.Close()
	}
}

// Delete drops name, first releasing any prepared standby sitting on it.
// Necessary, not cosmetic: a prepared-but-never-activated standby holds open
// idle connections, and Postgres refuses DROP DATABASE while any connection
// is open ("database is being accessed by other users") — without this, an
// operator who prepared a candidate and changed their mind would hit that
// raw error on Delete instead of it just working.
func (m *Manager) Delete(ctx context.Context, name string) error {
	m.Discard(name)
	return DropDatabase(ctx, m.conn, name, m.ActiveName())
}

// PrepareStatusFor reports name's current lifecycle state for List to
// surface — purely an in-memory map read, never touches the database.
func (m *Manager) PrepareStatusFor(name string) (status PrepareStatus, errMsg string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t := m.prepared[name]
	switch {
	case t == nil:
		return StatusUnprepared, ""
	case t.preparing:
		return StatusPreparing, ""
	case t.ready:
		return StatusReady, ""
	case t.err != nil:
		return StatusFailed, t.err.Error()
	default:
		return StatusUnprepared, ""
	}
}
