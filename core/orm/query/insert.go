package query

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	"core/orm/internal/cache"
	"core/orm/internal/scan"
	"core/orm/pool/executor"
)

// InsertBuilder constructs an INSERT query for type T.
// It reads column names and values from the struct via StructMeta,
// so there is no manual column listing at the call site.
//
// Basic usage:
//
//	result, err := Insert[Order](meta, order).
//	    Returning("id", "created_at").
//	    One(ctx, db)
//
// Batch usage (single round-trip via multi-row VALUES):
//
//	results, err := Insert[Order](meta, orders...).
//	    Returning("id").
//	    Batch(ctx, db)
type InsertBuilder[T any] struct {
	meta      cache.StructMeta
	rows      []T
	returning []string
}

// Insert creates an InsertBuilder for one or more values of type T.
func Insert[T any](meta cache.StructMeta, rows ...T) InsertBuilder[T] {
	return InsertBuilder[T]{meta: meta, rows: rows}
}

// Returning specifies columns to return via PostgreSQL's RETURNING clause.
// Pass "*" to return all columns.
func (b InsertBuilder[T]) Returning(cols ...string) InsertBuilder[T] {
	b.returning = cols
	return b
}

// ToSQL returns the INSERT statement and its argument slice.
// Produces a multi-row VALUES clause when more than one row was provided.
func (b InsertBuilder[T]) ToSQL() (string, []any) {
	cols := b.meta.WritableColumns()
	args := make([]any, 0, len(b.rows)*len(cols))

	// Build VALUES ($1,$2,…), ($N+1,…) for all rows.
	valueSets := make([]string, len(b.rows))
	for i, row := range b.rows {
		rv := reflect.ValueOf(row)
		set := make([]string, len(cols))
		for j, col := range cols {
			fidx := b.meta.ColumnIndex(col)
			if fidx < 0 {
				continue
			}
			fv := b.meta.Fields[fidx].FieldValue(rv)
			args = append(args, fv.Interface())
			set[j] = fmt.Sprintf("$%d", len(args))
		}
		valueSets[i] = "(" + strings.Join(set, ", ") + ")"
	}

	var sb strings.Builder
	sb.WriteString("INSERT INTO ")
	sb.WriteString(b.meta.Table)
	sb.WriteString(" (")
	sb.WriteString(strings.Join(cols, ", "))
	sb.WriteString(") VALUES ")
	sb.WriteString(strings.Join(valueSets, ", "))

	if len(b.returning) > 0 {
		sb.WriteString(" RETURNING ")
		sb.WriteString(strings.Join(b.returning, ", "))
	}

	return sb.String(), args
}

// One inserts a single row and scans the RETURNING columns back into T.
// Requires Returning() to be set; returns the inserted row with server-set
// values (e.g. id, created_at) populated.
func (b InsertBuilder[T]) One(ctx context.Context, ex executor.Executor) (T, error) {
	var zero T
	if len(b.rows) == 0 {
		return zero, fmt.Errorf("insert: no rows provided")
	}
	sql, args := b.ToSQL()
	row := ex.QueryRow(ctx, sql, args...)
	return scan.Row[T](row, b.meta)
}

// Batch inserts all rows in a single multi-row VALUES statement and returns
// the inserted rows with RETURNING columns populated.
// More efficient than N individual inserts for bulk ERP operations.
func (b InsertBuilder[T]) Batch(ctx context.Context, ex executor.Executor) ([]T, error) {
	if len(b.rows) == 0 {
		return nil, nil
	}
	sql, args := b.ToSQL()
	rows, err := ex.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("insert batch: %w", err)
	}
	return scan.Rows[T](rows, b.meta)
}

// Exec inserts all rows without scanning any result.
// Use when you don't need RETURNING (fire-and-forget inserts).
func (b InsertBuilder[T]) Exec(ctx context.Context, ex executor.Executor) error {
	if len(b.rows) == 0 {
		return nil
	}
	sql, args := b.ToSQL()
	_, err := ex.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("insert exec: %w", err)
	}
	return nil
}
