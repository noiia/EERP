// Package repo provides a generic Repository layer over the query builders.
// It is the optional convenience tier — every method it exposes can be
// replicated by calling the builders directly when you need more control.
//
// Constraint: T must embed model.BaseModel (uuid PK, timestamps, soft-delete).
// The Repository reads the StructMeta once at construction and reuses it for
// every operation — zero reflection after New().
package repo

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"core/orm/internal/cache"
	"core/orm/model"
	"core/orm/pool/executor"
	"core/orm/query"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Repository is a generic CRUD repository for any T that embeds model.BaseModel.
//
// Usage:
//
//	type Order struct {
//	    model.BaseModel
//	    Status string `db:"status"`
//	}
//
//	repo := repo.New[Order](db)
//	order, err := repo.FindByID(ctx, id)
type Repository[T model.Entity] struct {
	db   executor.Executor
	meta cache.StructMeta
}

// New constructs a Repository for T.
// Returns an error if T's metadata cannot be resolved (misconfigured struct tags).
func New[T model.Entity](db executor.Executor) (*Repository[T], error) {
	meta, err := cache.Get[T]()
	if err != nil {
		return nil, fmt.Errorf("repo: build metadata for %T: %w", *new(T), err)
	}
	return &Repository[T]{db: db, meta: meta}, nil
}

// MustNew is like New but panics on error. Use in main() / wire setup only.
func MustNew[T model.Entity](db executor.Executor) *Repository[T] {
	r, err := New[T](db)
	if err != nil {
		panic(err)
	}
	return r
}

// ── Accessors ─────────────────────────────────────────────────────────────────

// Meta returns the resolved StructMeta for T.
// Use it to pass to query builders when you need to drop below the repo layer:
//
//	orm.Select[Order](orders.Meta()).Join(...).All(ctx, db)
func (r *Repository[T]) Meta() cache.StructMeta {
	return r.meta
}

// WithTx returns a shallow copy of the Repository scoped to the given Tx.
// Use inside db.Transaction() to run repository operations atomically:
//
//	db.Transaction(ctx, func(tx *tx.Tx) error {
//	    _, err := orders.WithTx(tx).Create(ctx, newOrder)
//	    return err
//	})
func (r *Repository[T]) WithTx(tx executor.Executor) *Repository[T] {
	return &Repository[T]{db: tx, meta: r.meta}
}

// ── Read ──────────────────────────────────────────────────────────────────────

// FindByID returns the entity with the given UUID primary key.
// Soft-deleted rows are excluded automatically when DeletedAt is present.
// Returns an error wrapping pgx.ErrNoRows when not found.
func (r *Repository[T]) FindByID(ctx context.Context, id uuid.UUID) (T, error) {
	b := query.Select[T](r.meta).
		Where(query.NewCondition(r.meta.PK+" = $1", id))

	if _, hasSoftDel := r.meta.SoftDeleteField(); hasSoftDel {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	result, err := b.One(ctx, r.db)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("repo: FindByID %s: %w", id, err)
	}
	return result, nil
}

// FindOne returns the first active row matching the given conditions.
// Returns an error wrapping pgx.ErrNoRows when no row is found.
//
//	user, err := repo.FindOne(ctx, orm.Cond("email = $1", email))
func (r *Repository[T]) FindOne(ctx context.Context, conditions ...query.Condition) (T, error) {
	b := query.Select[T](r.meta)

	if _, hasSoftDel := r.meta.SoftDeleteField(); hasSoftDel {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	for _, c := range conditions {
		b = b.Where(c)
	}

	result, err := b.One(ctx, r.db)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("repo: FindOne: %w", err)
	}
	return result, nil
}

// Count returns the number of active (non-soft-deleted) rows matching the conditions.
//
//	n, err := repo.Count(ctx, orm.Cond("status = $1", "open"))
func (r *Repository[T]) Count(ctx context.Context, conditions ...query.Condition) (int64, error) {
	b := query.Select[T](r.meta)

	if _, hasSoftDel := r.meta.SoftDeleteField(); hasSoftDel {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	for _, c := range conditions {
		b = b.Where(c)
	}

	n, err := b.Count(ctx, r.db)
	if err != nil {
		return 0, fmt.Errorf("repo: Count: %w", err)
	}
	return n, nil
}

// FindAll returns all active (non-soft-deleted) rows matching the given conditions.
// Pass no conditions to return the full table — use carefully in ERP contexts.
func (r *Repository[T]) FindAll(ctx context.Context, conditions ...query.Condition) ([]T, error) {
	b := query.Select[T](r.meta)

	if _, hasSoftDel := r.meta.SoftDeleteField(); hasSoftDel {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	for _, c := range conditions {
		b = b.Where(c)
	}

	results, err := b.All(ctx, r.db)
	if err != nil {
		return nil, fmt.Errorf("repo: FindAll: %w", err)
	}
	return results, nil
}

// FindAllWithDeleted returns all rows including soft-deleted ones.
// Useful for audit views and ERP reconciliation screens.
func (r *Repository[T]) FindAllWithDeleted(ctx context.Context, conditions ...query.Condition) ([]T, error) {
	b := query.Select[T](r.meta)
	for _, c := range conditions {
		b = b.Where(c)
	}
	results, err := b.All(ctx, r.db)
	if err != nil {
		return nil, fmt.Errorf("repo: FindAllWithDeleted: %w", err)
	}
	return results, nil
}

// Query returns a SelectBuilder pre-configured for T, giving full control
// when FindAll's conditions aren't enough (complex JOINs, custom ordering).
//
//	rows, err := repo.Query().
//	    Join("JOIN customers c ON c.id = orders.customer_id").
//	    Where(query.NewCondition("c.region = $1", "EU")).
//	    OrderBy("orders.created_at DESC").
//	    Limit(50).
//	    All(ctx, db)
func (r *Repository[T]) Query() query.SelectBuilder[T] {
	return query.Select[T](r.meta)
}

// UpdateQuery returns an UpdateBuilder pre-configured for T — the WRITE-side
// counterpart to Query() — for a partial or conditionally-scoped update
// Update()'s full-row-replace-by-PK contract doesn't fit: bumping only SOME
// columns, or matching on something other than the primary key.
//
//	n, err := users.UpdateQuery().
//	    Set("preferred_locale", locale).
//	    Set("updated_at", time.Now()).
//	    Where(orm.Cond("id = $1", userID)).
//	    Where(orm.Cond("deleted_at IS NULL")).
//	    Exec(ctx, db)
func (r *Repository[T]) UpdateQuery() query.UpdateBuilder[T] {
	return query.Update[T](r.meta)
}

// ── Write ─────────────────────────────────────────────────────────────────────

// Create inserts a new entity and returns it with server-set values populated
// (id, created_at, updated_at from RETURNING *).
// The caller is responsible for setting ID before calling if not using UUID generation.
func (r *Repository[T]) Create(ctx context.Context, entity T) (T, error) {
	result, err := query.Insert[T](r.meta, entity).
		Returning("*").
		One(ctx, r.db)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("repo: Create: %w", err)
	}
	return result, nil
}

// Upsert inserts entity, or — on a conflict against conflictColumns — applies
// setFragment instead of failing. conflictColumns must be backed by a real
// unique index or constraint (struct tags have no unique-constraint support —
// a module's own Migrate() hook adds one by hand, e.g. a natural-key table
// like "one row per (tenant, user)" that has no meaningful surrogate-id
// lookup for Update to key off).
//
// setFragment is the same raw "col = EXCLUDED.col, other = now()" fragment
// InsertBuilder.DoUpdate already takes — deliberately NOT auto-derived from
// every writable column the way Update() replaces the whole row: a natural-key
// upsert commonly writes only SOME columns (e.g. bumping a "connected" flag)
// and must leave every other column — including one set by an unrelated
// concurrent write — untouched, which only an explicit fragment can express.
// EXCLUDED refers to the row that would have been inserted; a column left out
// of entity's non-zero writable fields is still available on EXCLUDED as long
// as it isn't also one of the zero-value audit timestamps InsertBuilder drops
// (see insertableColumns' timestampCols filter).
//
// setFragment == "" means DO NOTHING on conflict — idempotent, deterministic-
// id seeding (e.g. internal/auth/seed.go's INSERT ... ON CONFLICT (id) DO
// NOTHING statements) rather than an update. Postgres's own RETURNING never
// produces a row for a skipped DO NOTHING conflict, so that case re-reads the
// existing row by conflictColumns instead of surfacing a spurious not-found.
//
// Returns the resulting row (inserted, updated, or — DO NOTHING only —
// already-existing) via RETURNING *.
//
//	updated, err := presence.Upsert(ctx, row,
//	    []string{"tenant_id", "user_id"},
//	    "connected = EXCLUDED.connected, last_seen = now(), updated_at = now()")
//
//	role, err := roles.Upsert(ctx, Roles{BaseModel: model.BaseModel{ID: fixedID}, ...},
//	    []string{"id"}, "") // insert if absent; read back unchanged if not
func (r *Repository[T]) Upsert(ctx context.Context, entity T, conflictColumns []string, setFragment string) (T, error) {
	return r.upsert(ctx, entity, conflictColumns, "", setFragment)
}

// UpsertPartial is Upsert's counterpart for a conflictColumns target backed
// by a PARTIAL unique index/constraint — one declared with its own WHERE
// clause, e.g. "UNIQUE (code) WHERE deleted_at IS NULL", the soft-delete-safe
// natural-key shape this codebase hand-writes when a column can legitimately
// repeat across a live row and a soft-deleted one. Postgres can only use such
// an index as the ON CONFLICT arbiter when the INSERT repeats its exact
// predicate (see InsertBuilder.OnConflictWhere) — plain Upsert against a
// partial index fails with 42P10 regardless of whether any row actually
// conflicts. conflictWhere is that predicate, verbatim (e.g. "deleted_at IS
// NULL"); everything else matches Upsert exactly.
func (r *Repository[T]) UpsertPartial(ctx context.Context, entity T, conflictColumns []string, conflictWhere string, setFragment string) (T, error) {
	return r.upsert(ctx, entity, conflictColumns, conflictWhere, setFragment)
}

func (r *Repository[T]) upsert(ctx context.Context, entity T, conflictColumns []string, conflictWhere string, setFragment string) (T, error) {
	b := query.Insert[T](r.meta, entity).OnConflict(strings.Join(conflictColumns, ", "))
	if conflictWhere != "" {
		b = b.OnConflictWhere(conflictWhere)
	}
	result, err := b.
		DoUpdate(setFragment).
		Returning("*").
		One(ctx, r.db)
	if err != nil {
		if setFragment == "" && errors.Is(err, pgx.ErrNoRows) {
			return r.findByConflictColumns(ctx, conflictColumns, entity)
		}
		var zero T
		return zero, fmt.Errorf("repo: Upsert: %w", err)
	}
	return result, nil
}

// findByConflictColumns re-reads the row Upsert's DO NOTHING just left
// untouched, matching on conflictColumns' values from entity.
func (r *Repository[T]) findByConflictColumns(ctx context.Context, conflictColumns []string, entity T) (T, error) {
	rv := reflect.ValueOf(entity)
	conds := make([]query.Condition, 0, len(conflictColumns))
	for _, col := range conflictColumns {
		if fidx := r.meta.ColumnIndex(col); fidx >= 0 {
			conds = append(conds, query.NewCondition(col+" = $1", r.meta.Fields[fidx].FieldValue(rv).Interface()))
		}
	}
	result, err := r.FindOne(ctx, conds...)
	if err != nil {
		return result, fmt.Errorf("repo: Upsert: re-read after DO NOTHING conflict: %w", err)
	}
	return result, nil
}

// Update overwrites all writable fields for the entity identified by its PK.
// updated_at is set to now automatically.
// Returns the updated row via RETURNING *.
func (r *Repository[T]) Update(ctx context.Context, entity T, id uuid.UUID) (T, error) {
	now := time.Now()

	b := query.Update[T](r.meta).
		FromStruct(entity).
		Set("updated_at", now).
		Where(query.NewCondition(r.meta.PK+" = $1", id)).
		Returning("*")

	// Exclude soft-deleted rows from updates — silently protecting deleted data.
	if _, hasSoftDel := r.meta.SoftDeleteField(); hasSoftDel {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	result, err := b.One(ctx, r.db)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("repo: Update %s: %w", id, err)
	}
	return result, nil
}

// Delete performs a soft delete if the entity has a DeletedAt field,
// or a hard DELETE otherwise.
//
//   - Soft: sets deleted_at = now, returns rows affected
//   - Hard: issues DELETE FROM … WHERE id = $1, returns rows affected
func (r *Repository[T]) Delete(ctx context.Context, id uuid.UUID) (int64, error) {
	if _, hasSoftDel := r.meta.SoftDeleteField(); hasSoftDel {
		return r.softDelete(ctx, id)
	}
	return r.hardDelete(ctx, id)
}

// HardDelete unconditionally issues DELETE FROM regardless of soft-delete config.
// Use for permanent removal (GDPR erasure, test teardown).
func (r *Repository[T]) HardDelete(ctx context.Context, id uuid.UUID) (int64, error) {
	return r.hardDelete(ctx, id)
}

// Restore clears deleted_at for a soft-deleted entity.
// Returns ErrNotSoftDeletable if T has no soft-delete field.
func (r *Repository[T]) Restore(ctx context.Context, id uuid.UUID) error {
	if _, hasSoftDel := r.meta.SoftDeleteField(); !hasSoftDel {
		return fmt.Errorf("repo: Restore: %T does not have a soft-delete field", *new(T))
	}

	n, err := query.Update[T](r.meta).
		Set("deleted_at", nil).
		Set("updated_at", time.Now()).
		Where(query.NewCondition(r.meta.PK+" = $1", id)).
		Exec(ctx, r.db)
	if err != nil {
		return fmt.Errorf("repo: Restore %s: %w", id, err)
	}
	if n == 0 {
		return fmt.Errorf("repo: Restore %s: entity not found", id)
	}
	return nil
}

// ── Batch ─────────────────────────────────────────────────────────────────────

// CreateBatch inserts multiple entities in a single round-trip.
// Returns all inserted rows with server-set values via RETURNING *.
func (r *Repository[T]) CreateBatch(ctx context.Context, entities []T) ([]T, error) {
	if len(entities) == 0 {
		return nil, nil
	}
	results, err := query.Insert[T](r.meta, entities...).
		Returning("*").
		Batch(ctx, r.db)
	if err != nil {
		return nil, fmt.Errorf("repo: CreateBatch: %w", err)
	}
	return results, nil
}

// ── Internals ─────────────────────────────────────────────────────────────────

func (r *Repository[T]) softDelete(ctx context.Context, id uuid.UUID) (int64, error) {
	n, err := query.Update[T](r.meta).
		Set("deleted_at", time.Now()).
		Set("updated_at", time.Now()).
		Where(query.NewCondition(r.meta.PK+" = $1", id)).
		Where(query.NewCondition("deleted_at IS NULL")).
		Exec(ctx, r.db)
	if err != nil {
		return 0, fmt.Errorf("repo: Delete (soft) %s: %w", id, err)
	}
	return n, nil
}

func (r *Repository[T]) hardDelete(ctx context.Context, id uuid.UUID) (int64, error) {
	sql := fmt.Sprintf("DELETE FROM %s WHERE %s = $1", r.meta.Table, r.meta.PK)
	tag, err := r.db.Exec(ctx, sql, id)
	if err != nil {
		return 0, fmt.Errorf("repo: Delete (hard) %s: %w", id, err)
	}
	return tag.RowsAffected(), nil
}
