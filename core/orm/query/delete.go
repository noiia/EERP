package query

import (
	"context"
	"fmt"
	"strings"

	"core/orm/internal/cache"
	"core/orm/internal/scan"
	"core/orm/pool/executor"
)

// DeleteBuilder constructs a DELETE query for type T.
//
// Like UpdateBuilder, a DELETE without a WHERE clause is refused at ToSQL time.
// This is non-negotiable in an ERP context — a full-table delete is never
// the right default and must be expressed explicitly if truly intended.
//
// Basic usage:
//
//	n, err := Delete[Order](meta).
//	    Where(NewCondition("id = $1", orderID)).
//	    Exec(ctx, db)
//
// Soft-delete via UpdateBuilder is preferred for entities with DeletedAt.
// Use DeleteBuilder only for hard deletes (lookup tables, test teardown,
// GDPR erasure, entities without BaseModel).
//
// RETURNING support lets you retrieve the deleted rows for audit logging:
//
//	deleted, err := Delete[Order](meta).
//	    Where(NewCondition("status = $1", "cancelled")).
//	    Returning("id", "customer_id").
//	    All(ctx, db)
type DeleteBuilder[T any] struct {
	meta      cache.StructMeta
	wheres    []Condition
	returning []string
}

// Delete creates a DeleteBuilder for type T.
func Delete[T any](meta cache.StructMeta) DeleteBuilder[T] {
	return DeleteBuilder[T]{meta: meta}
}

// Where appends a WHERE condition joined by AND.
// At least one condition is required — ToSQL enforces this.
func (b DeleteBuilder[T]) Where(c Condition) DeleteBuilder[T] {
	b.wheres = append(append([]Condition{}, b.wheres...), c)
	return b
}

// Returning specifies columns to return via PostgreSQL's RETURNING clause.
// Use "*" to return all columns of the deleted rows.
func (b DeleteBuilder[T]) Returning(cols ...string) DeleteBuilder[T] {
	b.returning = cols
	return b
}

// ToSQL returns the DELETE statement and its argument slice.
// Returns an error when no WHERE conditions are present — a full-table
// DELETE is never produced silently.
func (b DeleteBuilder[T]) ToSQL() (string, []any, error) {
	if len(b.wheres) == 0 {
		return "", nil, fmt.Errorf(
			"delete: refusing to build DELETE on %q without WHERE clause",
			b.meta.Table,
		)
	}

	where, args := whereClause(b.wheres, 1)

	var sb strings.Builder
	sb.WriteString("DELETE FROM ")
	sb.WriteString(b.meta.Table)
	sb.WriteByte(' ')
	sb.WriteString(where)

	if len(b.returning) > 0 {
		sb.WriteString(" RETURNING ")
		sb.WriteString(strings.Join(b.returning, ", "))
	}

	return sb.String(), args, nil
}

// Exec runs the DELETE and returns the number of rows affected.
func (b DeleteBuilder[T]) Exec(ctx context.Context, ex executor.Executor) (int64, error) {
	sql, args, err := b.ToSQL()
	if err != nil {
		return 0, err
	}
	tag, err := ex.Exec(ctx, sql, args...)
	if err != nil {
		return 0, fmt.Errorf("delete exec: %w", err)
	}
	return tag.RowsAffected(), nil
}

// One runs DELETE … RETURNING and scans the first deleted row into T.
// Useful for atomic delete-and-return patterns.
func (b DeleteBuilder[T]) One(ctx context.Context, ex executor.Executor) (T, error) {
	var zero T
	sql, args, err := b.ToSQL()
	if err != nil {
		return zero, err
	}
	row := ex.QueryRow(ctx, sql, args...)
	return scan.Row[T](row, b.meta)
}

// All runs DELETE … RETURNING and scans all deleted rows into []T.
func (b DeleteBuilder[T]) All(ctx context.Context, ex executor.Executor) ([]T, error) {
	sql, args, err := b.ToSQL()
	if err != nil {
		return nil, err
	}
	rows, err := ex.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("delete all: %w", err)
	}
	return scan.Rows[T](rows, b.meta)
}
