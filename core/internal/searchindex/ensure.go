package searchindex

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/jackc/pgx/v5"
)

// lockKey serializes passes across processes (several core-back replicas,
// dev seeding during a maintainer tick). Distinct from internal/module's
// schema lock (7311990001): a long index build must not hold up a boot.
// It is only ever TRIED, never waited on — see EnsureWith.
const lockKey int64 = 7311990002

// Ensure applies DefaultPolicy. See EnsureWith.
func Ensure(ctx context.Context, db *orm.DB) ([]string, error) {
	return EnsureWith(ctx, db, DefaultPolicy)
}

// EnsureWith gives every Candidate whose statistics pass p a trigram index,
// built CONCURRENTLY (writes keep flowing), and rebuilds one an interrupted
// build left INVALID. Indexes are never dropped for a column that stops
// qualifying: a stable schema beats a flapping one. It returns the indexes it
// built; per-column failures are joined into err and never stop the others.
//
// When another pass holds lockKey, EnsureWith returns (nil, nil) at once: the
// pass is skipped, and the next one (hourly) catches up. It must never wait —
// a session blocked in pg_advisory_lock holds a snapshot that the holder's
// CREATE INDEX CONCURRENTLY waits out, while the waiter waits for the lock
// the holder releases only after that build: a deadlock Postgres can't see,
// since the cycle closes in Go.
//
// A pass with nothing to do issues reads only: db.Exec bumps the whole
// database's read-cache generation (core/orm/qcache) on any DDL.
func EnsureWith(ctx context.Context, db *orm.DB, p Policy) (created []string, err error) {
	conn, err := db.Pool().Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("searchindex: acquire lock connection: %w", err)
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", lockKey).Scan(&locked); err != nil {
		return nil, fmt.Errorf("searchindex: lock: %w", err)
	}
	if !locked {
		return nil, nil // another pass is running
	}
	defer func() {
		unlockCtx := context.WithoutCancel(ctx)
		if _, err := conn.Exec(unlockCtx, "SELECT pg_advisory_unlock($1)", lockKey); err != nil {
			// Never hand a connection still holding the lock back to the pool:
			// every later pass would skip until it is recycled.
			_ = conn.Conn().Close(unlockCtx)
		}
	}()

	candidates := Candidates()
	if len(candidates) == 0 {
		return nil, nil
	}
	stats, err := loadStats(ctx, db, candidates)
	if err != nil {
		return nil, err
	}
	trgm := extensionOnce(db)
	var errs []error
	for _, c := range candidates {
		s, ok := stats[c]
		if !ok || !p.Eligible(s) {
			continue
		}
		built, err := ensureIndex(ctx, db, c, trgm)
		if errors.Is(err, errNoTrgm) {
			// Already reported once; every other build would fail the same way.
			continue
		}
		if err != nil {
			errs = append(errs, err)
		}
		if built {
			created = append(created, IndexName(c))
		}
	}
	if err := trgm.err; err != nil {
		errs = append(errs, err)
	}
	return created, errors.Join(errs...)
}

// loadStats reads every candidate table's planner statistics in one query.
// A column absent from pg_stats (table never analyzed, or a column added
// since) is simply not eligible yet — autovacuum's next ANALYZE fixes that.
func loadStats(ctx context.Context, db *orm.DB, candidates []Candidate) (map[Candidate]ColumnStats, error) {
	tables := make([]string, 0, len(candidates))
	seen := map[string]bool{}
	for _, c := range candidates {
		if !seen[c.Table] {
			seen[c.Table] = true
			tables = append(tables, c.Table)
		}
	}
	rows, err := db.Query(ctx, `
		SELECT s.tablename, s.attname, c.reltuples, s.avg_width, s.n_distinct
		FROM pg_stats s
		JOIN pg_class c ON c.relname = s.tablename AND c.relnamespace = s.schemaname::regnamespace
		WHERE s.schemaname = current_schema() AND NOT s.inherited AND s.tablename = ANY($1)`, tables)
	if err != nil {
		return nil, fmt.Errorf("searchindex: read statistics: %w", err)
	}
	defer rows.Close()
	out := map[Candidate]ColumnStats{}
	for rows.Next() {
		var c Candidate
		var s ColumnStats
		if err := rows.Scan(&c.Table, &c.Column, &s.TableRows, &s.AvgWidth, &s.NDistinct); err != nil {
			return nil, fmt.Errorf("searchindex: scan statistics: %w", err)
		}
		out[c] = s
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("searchindex: read statistics: %w", err)
	}
	return out, nil
}

// ensureIndex builds c's index when it is missing, or drops and rebuilds it
// when an interrupted CONCURRENTLY build left it INVALID (IF NOT EXISTS
// alone would skip it forever). The pg_trgm extension is installed on first
// need only (trgm), for the same no-DDL-when-idle reason as EnsureWith.
func ensureIndex(ctx context.Context, db *orm.DB, c Candidate, trgm *extension) (built bool, err error) {
	name := IndexName(c)
	var valid bool
	err = db.QueryRow(ctx, `
		SELECT i.indisvalid FROM pg_class ic JOIN pg_index i ON i.indexrelid = ic.oid
		WHERE ic.relname = $1 AND ic.relnamespace = current_schema()::regnamespace`, name).Scan(&valid)
	exists := err == nil
	switch {
	case exists && valid:
		return false, nil
	case !exists && !errors.Is(err, pgx.ErrNoRows):
		return false, fmt.Errorf("searchindex: inspect %s: %w", name, err)
	}
	if !trgm.ensure(ctx) {
		return false, errNoTrgm
	}
	if exists { // invalid
		if _, err := db.Exec(ctx, "DROP INDEX CONCURRENTLY IF EXISTS "+pgx.Identifier{name}.Sanitize()); err != nil {
			return false, fmt.Errorf("searchindex: drop invalid %s: %w", name, err)
		}
	}
	// #nosec G202 — identifiers come from the ORM registry, quoted anyway.
	sql := fmt.Sprintf("CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s USING gin (%s gin_trgm_ops)",
		pgx.Identifier{name}.Sanitize(), pgx.Identifier{c.Table}.Sanitize(), pgx.Identifier{c.Column}.Sanitize())
	if _, err := db.Exec(ctx, sql); err != nil {
		return false, fmt.Errorf("searchindex: create %s: %w", name, err)
	}
	return true, nil
}

// errNoTrgm marks a build skipped because pg_trgm is unavailable; the cause
// is reported once per pass, through extension.err.
var errNoTrgm = errors.New("searchindex: pg_trgm unavailable")

// extension checks and installs pg_trgm at most once per pass, so a role
// refused CREATE EXTENSION yields one error, not one per eligible column.
type extension struct {
	db      *orm.DB
	checked bool
	ok      bool
	err     error
}

func extensionOnce(db *orm.DB) *extension { return &extension{db: db} }

// ensure reports whether pg_trgm is installed, installing it on the first
// call when absent (read first: see EnsureWith). Installing needs a role
// allowed to create extensions, like internal/module's PostGIS; on a managed
// database have an admin run CREATE EXTENSION pg_trgm once.
func (e *extension) ensure(ctx context.Context) bool {
	if e.checked {
		return e.ok
	}
	e.checked = true
	var present bool
	if err := e.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')`).Scan(&present); err != nil {
		e.err = fmt.Errorf("searchindex: check pg_trgm: %w", err)
		return false
	}
	if !present {
		if _, err := e.db.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS pg_trgm"); err != nil {
			e.err = fmt.Errorf("searchindex: create extension pg_trgm: %w", err)
			return false
		}
	}
	e.ok = true
	return true
}
