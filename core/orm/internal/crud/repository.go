package crud

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"core/orm/internal/registry"
	"core/orm/pool/executor"
	"core/orm/query"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrNotFound is returned by FindByID when no row matches the given id
// (or the row is soft-deleted). Callers use errors.Is to detect it.
var ErrNotFound = errors.New("not found")

// Repository performs generic CRUD on a single table, returning map[string]any
// rows. It uses the query builders for SQL generation and custom map-scanning.
type Repository struct {
	db   executor.Executor
	meta registry.TableMeta
}

// NewRepository constructs a Repository bound to the given executor and table.
func NewRepository(db executor.Executor, meta registry.TableMeta) *Repository {
	return &Repository{db: db, meta: meta}
}

// FindAll returns a paginated slice of rows and the total non-deleted count.
func (r *Repository) FindAll(ctx context.Context, page, pageSize int) ([]map[string]any, int, error) {
	b := query.Select[struct{}](r.meta.StructMeta)
	if r.meta.SoftDelete {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	total, err := b.Count(ctx, r.db)
	if err != nil {
		return nil, 0, fmt.Errorf("crud: count %s: %w", r.meta.TableName, err)
	}

	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	sql, args := b.Offset(offset).Limit(pageSize).ToSQL()
	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("crud: find all %s: %w", r.meta.TableName, err)
	}

	results, err := scanToMaps(rows)
	if err != nil {
		return nil, 0, err
	}
	return results, int(total), nil
}

// FindByID returns the single row with the given id. Returns ErrNotFound when
// the row does not exist or is soft-deleted.
func (r *Repository) FindByID(ctx context.Context, id any) (map[string]any, error) {
	b := query.Select[struct{}](r.meta.StructMeta).
		Where(query.NewCondition(r.meta.PKField.Column+" = $1", id))
	if r.meta.SoftDelete {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	sql, args := b.Limit(1).ToSQL()
	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("crud: find by id: %w", err)
	}

	results, err := scanToMaps(rows)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("crud: find by id %v: %w", id, ErrNotFound)
	}
	return results[0], nil
}

// Create inserts a new row and returns it with all server-set columns populated
// via RETURNING *.
func (r *Repository) Create(ctx context.Context, data map[string]any) (map[string]any, error) {
	cols, vals := r.orderedData(data)
	if len(cols) == 0 {
		return nil, fmt.Errorf("crud: create %s: no data", r.meta.TableName)
	}

	placeholders := make([]string, len(cols))
	for i := range cols {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	sql := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES (%s) RETURNING *",
		r.meta.TableName,
		strings.Join(cols, ", "),
		strings.Join(placeholders, ", "),
	)

	rows, err := r.db.Query(ctx, sql, vals...)
	if err != nil {
		return nil, fmt.Errorf("crud: create %s: %w", r.meta.TableName, err)
	}

	results, err := scanToMaps(rows)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("crud: create %s: no row returned", r.meta.TableName)
	}
	return results[0], nil
}

// Update overwrites the writable columns for the row identified by id.
// Returns ErrNotFound when no row is affected.
func (r *Repository) Update(ctx context.Context, id any, data map[string]any) (map[string]any, error) {
	b := query.Update[struct{}](r.meta.StructMeta)

	for _, f := range r.meta.Fields {
		if f.Column == r.meta.PKField.Column {
			continue // never overwrite PK
		}
		val, ok := data[f.Column]
		if !ok {
			continue
		}
		b = b.Set(f.Column, val)
	}

	b = b.
		Where(query.NewCondition(r.meta.PKField.Column+" = $1", id)).
		Returning("*")

	if r.meta.SoftDelete {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}

	sql, args, err := b.ToSQL()
	if err != nil {
		return nil, fmt.Errorf("crud: update %s: %w", r.meta.TableName, err)
	}

	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("crud: update %s: %w", r.meta.TableName, err)
	}

	results, err := scanToMaps(rows)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("crud: update %s %v: %w", r.meta.TableName, id, ErrNotFound)
	}
	return results[0], nil
}

// Delete soft-deletes the row if the table has a soft-delete field, otherwise
// performs a hard DELETE. Returns ErrNotFound when no row is affected.
func (r *Repository) Delete(ctx context.Context, id any) error {
	if r.meta.SoftDelete {
		return r.softDelete(ctx, id)
	}
	return r.hardDelete(ctx, id)
}

// Restore clears deleted_at for a soft-deleted row. Returns ErrNotFound when
// no row matches id. Panics if the table does not support soft delete (callers
// must guard with meta.SoftDelete before calling).
func (r *Repository) Restore(ctx context.Context, id any) (map[string]any, error) {
	b := query.Update[struct{}](r.meta.StructMeta).
		Set("deleted_at", nil).
		Set("updated_at", time.Now()).
		Where(query.NewCondition(r.meta.PKField.Column+" = $1", id)).
		Returning("*")

	sql, args, err := b.ToSQL()
	if err != nil {
		return nil, fmt.Errorf("crud: restore %s: %w", r.meta.TableName, err)
	}

	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("crud: restore %s: %w", r.meta.TableName, err)
	}

	results, err := scanToMaps(rows)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("crud: restore %s %v: %w", r.meta.TableName, id, ErrNotFound)
	}
	return results[0], nil
}

// ── internals ─────────────────────────────────────────────────────────────────

func (r *Repository) softDelete(ctx context.Context, id any) error {
	b := query.Update[struct{}](r.meta.StructMeta).
		Set("deleted_at", time.Now()).
		Set("updated_at", time.Now()).
		Where(query.NewCondition(r.meta.PKField.Column+" = $1", id)).
		Where(query.NewCondition("deleted_at IS NULL"))

	sql, args, err := b.ToSQL()
	if err != nil {
		return fmt.Errorf("crud: delete %s: %w", r.meta.TableName, err)
	}

	tag, err := r.db.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("crud: delete %s: %w", r.meta.TableName, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("crud: delete %s %v: %w", r.meta.TableName, id, ErrNotFound)
	}
	return nil
}

func (r *Repository) hardDelete(ctx context.Context, id any) error {
	b := query.Delete[struct{}](r.meta.StructMeta).
		Where(query.NewCondition(r.meta.PKField.Column+" = $1", id))

	sql, args, err := b.ToSQL()
	if err != nil {
		return fmt.Errorf("crud: delete %s: %w", r.meta.TableName, err)
	}

	tag, err := r.db.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("crud: delete %s: %w", r.meta.TableName, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("crud: delete %s %v: %w", r.meta.TableName, id, ErrNotFound)
	}
	return nil
}

// orderedData iterates meta.Fields in order and returns aligned cols/vals slices
// for only the columns present in data. Deterministic ordering ensures stable SQL.
func (r *Repository) orderedData(data map[string]any) ([]string, []any) {
	cols := make([]string, 0, len(data))
	vals := make([]any, 0, len(data))
	for _, f := range r.meta.Fields {
		if val, ok := data[f.Column]; ok {
			cols = append(cols, f.Column)
			vals = append(vals, val)
		}
	}
	return cols, vals
}

// scanToMaps reads all rows from pgx.Rows into []map[string]any, keyed by
// column name. [16]byte values (pgx-native UUID representation) are converted
// to uuid.UUID so they marshal as "xxxxxxxx-xxxx-…" strings in JSON.
func scanToMaps(rows pgx.Rows) ([]map[string]any, error) {
	defer rows.Close()

	descs := rows.FieldDescriptions()
	var out []map[string]any

	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, fmt.Errorf("crud: scan row: %w", err)
		}
		m := make(map[string]any, len(descs))
		for i, d := range descs {
			m[string(d.Name)] = normalizeValue(vals[i])
		}
		out = append(out, m)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("crud: scan rows: %w", err)
	}
	return out, nil
}

// normalizeValue converts pgx-native types to JSON-friendly Go types.
func normalizeValue(v any) any {
	if arr, ok := v.([16]byte); ok {
		return uuid.UUID(arr)
	}
	return v
}
