package query

import (
	"context"
	"fmt"
	"strings"

	"core/orm/internal/cache"
	"core/orm/internal/scan"
	"core/orm/pool/executor"
)

// SelectBuilder constructs a SELECT query for type T.
// All methods return a new copy — the builder is immutable and safe to branch:
//
//	base := Select[Order](meta).Where(NewCondition("deleted_at IS NULL"))
//	open := base.Where(NewCondition("status = $1", "open")).Limit(10)
//	all  := base.All(ctx, db)   // unaffected by open's extra conditions
type SelectBuilder[T any] struct {
	meta    cache.StructMeta
	cols    []string // explicit column list; nil means SELECT *
	wheres  []Condition
	joins   []string
	orderBy []string
	limit   int // 0 = no limit
	offset  int // 0 = no offset
}

// Select creates a SelectBuilder for T using the provided StructMeta.
// Prefer the cache.Get[T]() helper to obtain the meta.
func Select[T any](meta cache.StructMeta) SelectBuilder[T] {
	return SelectBuilder[T]{meta: meta}
}

// Columns restricts the SELECT to specific columns.
// Default is all mapped columns (SELECT col1, col2, …).
func (b SelectBuilder[T]) Columns(cols ...string) SelectBuilder[T] {
	b.cols = cols
	return b
}

// Where appends a condition joined by AND.
// The condition's $N placeholders are rebased automatically.
func (b SelectBuilder[T]) Where(c Condition) SelectBuilder[T] {
	b.wheres = append(append([]Condition{}, b.wheres...), c)
	return b
}

// Join appends a raw JOIN clause (e.g. "JOIN order_lines ol ON ol.order_id = o.id").
func (b SelectBuilder[T]) Join(clause string) SelectBuilder[T] {
	b.joins = append(append([]string{}, b.joins...), clause)
	return b
}

// OrderBy appends an ORDER BY expression (e.g. "created_at DESC").
func (b SelectBuilder[T]) OrderBy(expr string) SelectBuilder[T] {
	b.orderBy = append(append([]string{}, b.orderBy...), expr)
	return b
}

// Limit sets the maximum number of rows returned. 0 means no limit.
func (b SelectBuilder[T]) Limit(n int) SelectBuilder[T] {
	b.limit = n
	return b
}

// Offset sets the number of rows to skip. 0 means no offset.
func (b SelectBuilder[T]) Offset(n int) SelectBuilder[T] {
	b.offset = n
	return b
}

// ToSQL returns the final SQL string and argument slice.
// The query is always fully parameterised — no string interpolation of values.
func (b SelectBuilder[T]) ToSQL() (string, []any) {
	var sb strings.Builder

	// SELECT
	sb.WriteString("SELECT ")
	if len(b.cols) > 0 {
		sb.WriteString(strings.Join(b.cols, ", "))
	} else {
		sb.WriteString(strings.Join(b.meta.Columns(), ", "))
	}

	// FROM
	sb.WriteString(" FROM ")
	sb.WriteString(b.meta.Table)

	// JOINs
	for _, j := range b.joins {
		sb.WriteByte(' ')
		sb.WriteString(j)
	}

	// WHERE
	where, args := whereClause(b.wheres, 1)
	if where != "" {
		sb.WriteByte(' ')
		sb.WriteString(where)
	}

	// ORDER BY
	if len(b.orderBy) > 0 {
		sb.WriteString(" ORDER BY ")
		sb.WriteString(strings.Join(b.orderBy, ", "))
	}

	// LIMIT / OFFSET
	if b.limit > 0 {
		sb.WriteString(fmt.Sprintf(" LIMIT %d", b.limit))
	}
	if b.offset > 0 {
		sb.WriteString(fmt.Sprintf(" OFFSET %d", b.offset))
	}

	return sb.String(), args
}

// All executes the query and returns all matching rows as []T.
func (b SelectBuilder[T]) All(ctx context.Context, ex executor.Executor) ([]T, error) {
	sql, args := b.ToSQL()
	rows, err := ex.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("select: query: %w", err)
	}
	return scan.Rows[T](rows, b.meta)
}

// One executes the query with LIMIT 1 and returns the first matching row.
// Returns an error wrapping pgx.ErrNoRows when no row is found.
func (b SelectBuilder[T]) One(ctx context.Context, ex executor.Executor) (T, error) {
	sql, args := b.Limit(1).ToSQL()
	row := ex.QueryRow(ctx, sql, args...)
	return scan.Row[T](row, b.meta)
}
