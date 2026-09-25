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
	startedAt  time.Time // when this Prepare attempt began
	finishedAt time.Time // zero while still preparing
	// progressDone/progressTotal mirror module.Registry.BootWithProgress's
	// own done/total (Go modules processed so far / in this deployment) —
	// see that method's doc comment for why Go-module count is effectively
	// the whole workload today. Both zero before the first callback fires.
	progressDone  int
	progressTotal int
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
//
// Every outcome (connect failure, provisioning failure, success) MUTATES the
// SAME *preparedTarget in place rather than replacing the map entry — that's
// what keeps whatever progressDone/progressTotal onProgress last recorded
// visible even after a failure, instead of a fresh struct silently
// discarding it. Ensures the entry exists first, so this works identically
// whether Prepare already inserted a "preparing" placeholder or
// CreateAndProvision calls straight in with none.
func (m *Manager) provisionAndKeepWarm(ctx context.Context, name string, startedAt time.Time) error {
	m.mu.Lock()
	target := m.prepared[name]
	if target == nil {
		target = &preparedTarget{startedAt: startedAt}
		m.prepared[name] = target
	}
	target.preparing = true
	m.mu.Unlock()

	onProgress := func(done, total int) {
		m.mu.Lock()
		target.progressDone, target.progressTotal = done, total
		m.mu.Unlock()
	}

	fail := func(err error) error {
		m.mu.Lock()
		target.preparing, target.ready, target.err = false, false, err
		target.finishedAt = time.Now()
		m.mu.Unlock()
		return err
	}

	tmp, err := orm.New(orm.Config{DSN: m.conn.dsn(name), MaxConns: m.maxConns, MinConns: m.minConns}, common.Logger)
	if err != nil {
		return fail(fmt.Errorf("dbmanage: connect to %s: %w", name, err))
	}

	if err := m.provisioner.ProvisionWithProgress(ctx, tmp.DB, onProgress); err != nil {
		tmp.Close() // don't leak a failed attempt's connections
		return fail(err)
	}

	finishedAt := time.Now()
	m.mu.Lock()
	target.preparing, target.ready, target.err = false, true, nil
	target.pool = tmp.DB.Pool()
	target.finishedAt = finishedAt
	m.lastPrepareDuration = finishedAt.Sub(target.startedAt)
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
	startedAt := time.Now()
	m.prepared[name] = &preparedTarget{preparing: true, startedAt: startedAt}
	m.mu.Unlock()

	return m.provisionAndKeepWarm(ctx, name, startedAt)
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
		now := time.Now()
		m.prepared[oldName] = &preparedTarget{pool: oldPool, ready: true, startedAt: now, finishedAt: now}
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

// PrepareInfo is name's current lifecycle state for List to surface —
// everything a progress UI needs, in one read.
type PrepareInfo struct {
	Status PrepareStatus
	Error  string
	// ProgressDone/ProgressTotal are 0/0 until the first BootWithProgress
	// callback fires (or always, once finished — see PrepareInfoFor's own
	// doc comment for why they're left in place rather than reset).
	ProgressDone  int
	ProgressTotal int
	// ElapsedSeconds is time.Since(startedAt) while still preparing, or the
	// attempt's actual total duration once ready/failed — either way, "how
	// long has/did this take."
	ElapsedSeconds float64
	// EstimatedSeconds is Manager.lastPrepareDuration — the most recent
	// successful Prepare's own duration in THIS process, used as a rough
	// forecast for one still running. Zero (omit) when nothing has ever
	// completed in this process yet, or once this attempt is no longer
	// "preparing" (the real ElapsedSeconds is the more useful number then).
	EstimatedSeconds float64
}

// PrepareInfoFor reports name's current lifecycle state for List to
// surface — purely an in-memory read (the map, plus Manager's own
// lastPrepareDuration for the estimate), never touches the database.
func (m *Manager) PrepareInfoFor(name string) PrepareInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t := m.prepared[name]
	if t == nil {
		return PrepareInfo{Status: StatusUnprepared}
	}
	switch {
	case t.preparing:
		return PrepareInfo{
			Status:           StatusPreparing,
			ProgressDone:     t.progressDone,
			ProgressTotal:    t.progressTotal,
			ElapsedSeconds:   time.Since(t.startedAt).Seconds(),
			EstimatedSeconds: m.lastPrepareDuration.Seconds(),
		}
	case t.ready:
		return PrepareInfo{
			Status:         StatusReady,
			ProgressDone:   t.progressDone,
			ProgressTotal:  t.progressTotal,
			ElapsedSeconds: t.finishedAt.Sub(t.startedAt).Seconds(),
		}
	case t.err != nil:
		return PrepareInfo{
			Status:         StatusFailed,
			Error:          t.err.Error(),
			ProgressDone:   t.progressDone,
			ProgressTotal:  t.progressTotal,
			ElapsedSeconds: t.finishedAt.Sub(t.startedAt).Seconds(),
		}
	default:
		return PrepareInfo{Status: StatusUnprepared}
	}
}
