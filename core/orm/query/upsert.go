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

// ConflictAction defines what happens when a unique constraint is violated.
type ConflictAction int

const (
	// ConflictDoNothing silently ignores the conflicting row.
	// The existing row is left unchanged.
	ConflictDoNothing ConflictAction = iota

	// ConflictDoUpdate overwrites the conflicting row's columns with the
	// new values — "upsert" semantics.
	ConflictDoUpdate
)

// UpsertBuilder constructs an INSERT … ON CONFLICT statement for type T.
//
// PostgreSQL-native upsert is critical for ERP import/sync flows where the
// same record may arrive multiple times (stock movements, price lists,
// external catalogue imports).
//
// Basic upsert (update all writable columns on conflict):
//
//	result, err := Upsert[Product](meta, product).
//	    OnConflict("sku").
//	    DoUpdate().
//	    Returning("*").
//	    One(ctx, db)
//
// Partial update (only update specific columns on conflict):
//
//	result, err := Upsert[Product](meta, product).
//	    OnConflict("sku").
//	    DoUpdateSet("price", "updated_at").
//	    Returning("*").
//	    One(ctx, db)
//
// Ignore duplicates silently:
//
//	err := Upsert[Product](meta, product).
//	    OnConflict("sku").
//	    DoNothing().
//	    Exec(ctx, db)
type UpsertBuilder[T any] struct {
	meta         cache.StructMeta
	rows         []T
	conflictCols []string // columns in ON CONFLICT (col1, col2)
	action       ConflictAction
	updateCols   []string // nil = update all writable; non-nil = update only these
	returning    []string
}

// Upsert creates an UpsertBuilder for one or more values of type T.
func Upsert[T any](meta cache.StructMeta, rows ...T) UpsertBuilder[T] {
	return UpsertBuilder[T]{meta: meta, rows: rows}
}

// OnConflict specifies the column(s) whose uniqueness constraint triggers
// the conflict resolution. Typically the natural key (e.g. "sku", "email")
// or a composite key ("order_id", "line_number").
func (b UpsertBuilder[T]) OnConflict(cols ...string) UpsertBuilder[T] {
	b.conflictCols = cols
	return b
}

// DoUpdate sets the action to UPDATE all writable columns on conflict.
// Equivalent to: ON CONFLICT (…) DO UPDATE SET col1 = EXCLUDED.col1, …
func (b UpsertBuilder[T]) DoUpdate() UpsertBuilder[T] {
	b.action = ConflictDoUpdate
	b.updateCols = nil // all writable
	return b
}

// DoUpdateSet sets the action to UPDATE only the specified columns on conflict.
// Use this for partial upserts — e.g. update price and updated_at but
// never overwrite created_at or ownership columns.
func (b UpsertBuilder[T]) DoUpdateSet(cols ...string) UpsertBuilder[T] {
	b.action = ConflictDoUpdate
	b.updateCols = cols
	return b
}

// DoNothing sets the action to silently ignore conflicting rows.
// The row in the database is left completely unchanged.
func (b UpsertBuilder[T]) DoNothing() UpsertBuilder[T] {
	b.action = ConflictDoNothing
	return b
}

// Returning specifies columns to return via RETURNING.
// Use "*" to return the full row as it exists after the upsert.
func (b UpsertBuilder[T]) Returning(cols ...string) UpsertBuilder[T] {
	b.returning = cols
	return b
}

// ToSQL returns the complete INSERT … ON CONFLICT statement and args.
// Returns an error if no conflict columns were specified.
func (b UpsertBuilder[T]) ToSQL() (string, []any, error) {
	if len(b.rows) == 0 {
		return "", nil, fmt.Errorf("upsert: no rows provided")
	}
	if len(b.conflictCols) == 0 {
		return "", nil, fmt.Errorf("upsert: OnConflict() must specify at least one column")
	}

	writableCols := b.meta.WritableColumns()
	args := make([]any, 0, len(b.rows)*len(writableCols))

	// Build VALUES clause — identical to InsertBuilder.
	valueSets := make([]string, len(b.rows))
	for i, row := range b.rows {
		rv := reflect.ValueOf(row)
		set := make([]string, len(writableCols))
		for j, col := range writableCols {
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
	sb.WriteString(strings.Join(writableCols, ", "))
	sb.WriteString(") VALUES ")
	sb.WriteString(strings.Join(valueSets, ", "))

	// ON CONFLICT clause.
	sb.WriteString(" ON CONFLICT (")
	sb.WriteString(strings.Join(b.conflictCols, ", "))
	sb.WriteString(")")

	switch b.action {
	case ConflictDoNothing:
		sb.WriteString(" DO NOTHING")

	case ConflictDoUpdate:
		sb.WriteString(" DO UPDATE SET ")

		// Determine which columns to update.
		updateCols := b.updateCols
		if len(updateCols) == 0 {
			// Default: update all writable columns except the conflict key itself.
			conflictSet := make(map[string]struct{}, len(b.conflictCols))
			for _, c := range b.conflictCols {
				conflictSet[c] = struct{}{}
			}
			updateCols = make([]string, 0, len(writableCols))
			for _, c := range writableCols {
				if _, isConflict := conflictSet[c]; !isConflict {
					updateCols = append(updateCols, c)
				}
			}
		}

		if len(updateCols) == 0 {
			return "", nil, fmt.Errorf("upsert: DoUpdate has no columns to update")
		}

		// SET col = EXCLUDED.col for each update column.
		setParts := make([]string, len(updateCols))
		for i, col := range updateCols {
			setParts[i] = fmt.Sprintf("%s = EXCLUDED.%s", col, col)
		}
		sb.WriteString(strings.Join(setParts, ", "))
	}

	if len(b.returning) > 0 {
		sb.WriteString(" RETURNING ")
		sb.WriteString(strings.Join(b.returning, ", "))
	}

	return sb.String(), args, nil
}

// One executes the upsert and scans the RETURNING row into T.
// Uses Query (not QueryRow) so FieldDescriptions are available for correct
// name-based column mapping — required when RETURNING * is used.
// Requires Returning() to be set.
func (b UpsertBuilder[T]) One(ctx context.Context, ex executor.Executor) (T, error) {
	var zero T
	sql, args, err := b.ToSQL()
	if err != nil {
		return zero, err
	}
	rows, err := ex.Query(ctx, sql, args...)
	if err != nil {
		return zero, fmt.Errorf("upsert one: %w", err)
	}
	return scan.RowFromRows[T](rows, b.meta)
}

// Batch executes the upsert for all rows and returns results via RETURNING.
func (b UpsertBuilder[T]) Batch(ctx context.Context, ex executor.Executor) ([]T, error) {
	sql, args, err := b.ToSQL()
	if err != nil {
		return nil, err
	}
	rows, err := ex.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("upsert batch: %w", err)
	}
	return scan.Rows[T](rows, b.meta)
}

// Exec executes the upsert without scanning any result.
func (b UpsertBuilder[T]) Exec(ctx context.Context, ex executor.Executor) error {
	sql, args, err := b.ToSQL()
	if err != nil {
		return err
	}
	if _, err := ex.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("upsert exec: %w", err)
	}
	return nil
}
