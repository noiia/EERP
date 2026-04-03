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

// UpdateBuilder constructs an UPDATE query for type T.
//
// Column values can be provided two ways:
//  1. From a full struct via UpdateBuilder.FromStruct — all writable columns are set.
//  2. Explicitly via Set(col, val) — only the named columns are updated.
//
// Both approaches require at least one Where condition.
// Running an UPDATE without a WHERE clause is rejected at ToSQL time to prevent
// accidental full-table updates — a hard lesson in every ERP codebase.
//
// Example:
//
//	tag, err := Update[Order](meta).
//	    Set("status", "shipped").
//	    Set("updated_at", time.Now()).
//	    Where(NewCondition("id = $1", orderID)).
//	    Exec(ctx, db)
type UpdateBuilder[T any] struct {
	meta      cache.StructMeta
	sets      []setClause // ordered to keep SQL deterministic
	wheres    []Condition
	returning []string
}

type setClause struct {
	col string
	val any
}

// Update creates an UpdateBuilder for type T.
func Update[T any](meta cache.StructMeta) UpdateBuilder[T] {
	return UpdateBuilder[T]{meta: meta}
}

// FromStruct populates SET clauses from all writable fields of v.
// Fields with OmitEmpty=true that hold their zero value are skipped.
// The PK column is always excluded from SET (it goes in WHERE).
func (b UpdateBuilder[T]) FromStruct(v T) UpdateBuilder[T] {
	rv := reflect.ValueOf(v)
	sets := make([]setClause, 0, len(b.meta.Fields))
	for _, f := range b.meta.Fields {
		if f.IsPK {
			continue
		}
		fv := f.FieldValue(rv)
		if f.OmitEmpty && fv.IsZero() {
			continue
		}
		sets = append(sets, setClause{col: f.Column, val: fv.Interface()})
	}
	b.sets = append(append([]setClause{}, b.sets...), sets...)
	return b
}

// Set adds a single column=value pair to the SET clause.
func (b UpdateBuilder[T]) Set(col string, val any) UpdateBuilder[T] {
	b.sets = append(append([]setClause{}, b.sets...), setClause{col: col, val: val})
	return b
}

// Where appends a WHERE condition joined by AND.
func (b UpdateBuilder[T]) Where(c Condition) UpdateBuilder[T] {
	b.wheres = append(append([]Condition{}, b.wheres...), c)
	return b
}

// Returning specifies columns to return via RETURNING.
func (b UpdateBuilder[T]) Returning(cols ...string) UpdateBuilder[T] {
	b.returning = cols
	return b
}

// ToSQL returns the UPDATE statement and its argument slice.
// Returns an error if no SET clauses or no WHERE conditions are present.
func (b UpdateBuilder[T]) ToSQL() (string, []any, error) {
	if len(b.sets) == 0 {
		return "", nil, fmt.Errorf("update: no SET clauses provided")
	}
	if len(b.wheres) == 0 {
		return "", nil, fmt.Errorf("update: refusing to build UPDATE without WHERE clause")
	}

	args := make([]any, 0, len(b.sets)+4)
	setParts := make([]string, len(b.sets))

	for i, s := range b.sets {
		args = append(args, s.val)
		setParts[i] = fmt.Sprintf("%s = $%d", s.col, len(args))
	}

	// WHERE conditions are numbered starting after the SET args.
	where, whereArgs := whereClause(b.wheres, len(args)+1)
	args = append(args, whereArgs...)

	var sb strings.Builder
	sb.WriteString("UPDATE ")
	sb.WriteString(b.meta.Table)
	sb.WriteString(" SET ")
	sb.WriteString(strings.Join(setParts, ", "))
	sb.WriteByte(' ')
	sb.WriteString(where)

	if len(b.returning) > 0 {
		sb.WriteString(" RETURNING ")
		sb.WriteString(strings.Join(b.returning, ", "))
	}

	return sb.String(), args, nil
}

// Exec runs the UPDATE and returns the number of rows affected.
func (b UpdateBuilder[T]) Exec(ctx context.Context, ex executor.Executor) (int64, error) {
	sql, args, err := b.ToSQL()
	if err != nil {
		return 0, err
	}
	tag, err := ex.Exec(ctx, sql, args...)
	if err != nil {
		return 0, fmt.Errorf("update exec: %w", err)
	}
	return tag.RowsAffected(), nil
}

// One runs the UPDATE … RETURNING and scans the first returned row into T.
func (b UpdateBuilder[T]) One(ctx context.Context, ex executor.Executor) (T, error) {
	sql, args, err := b.ToSQL()
	if err != nil {
		var zero T
		return zero, err
	}
	row := ex.QueryRow(ctx, sql, args...)
	return scan.Row[T](row, b.meta)
}

// All runs UPDATE … RETURNING and scans all returned rows.
// Useful for bulk updates where you need the affected rows back.
func (b UpdateBuilder[T]) All(ctx context.Context, ex executor.Executor) ([]T, error) {
	sql, args, err := b.ToSQL()
	if err != nil {
		return nil, err
	}
	rows, err := ex.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("update all: %w", err)
	}
	return scan.Rows[T](rows, b.meta)
}
