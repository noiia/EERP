// Package scan maps pgx query results onto typed Go structs.
// It is the only package in the ORM that calls reflect at runtime —
// everything else is statically typed via generics.
//
// The hot path is:
//  1. pgx returns column names via rows.FieldDescriptions()
//  2. We build a one-time []int index mapping column position → Fields index
//  3. Each row is scanned into a []any dest slice, then copied into the struct
//     via FieldMeta.FieldValue + reflect.Value.Set
//
// The column→field mapping is built once per query result set (not per row),
// so reflection cost is O(cols) + O(rows×cols) with no map lookups per row.
package scan

import (
	"fmt"
	"reflect"

	"core/orm/internal/cache"

	"github.com/jackc/pgx/v5"
)

// Rows scans all rows into a []T slice.
// It closes rows before returning — callers must not call rows.Close().
//
// Column matching is by name (case-sensitive, using the db tag or snake_case).
// Columns returned by the query that have no matching field are silently skipped.
// Fields in the struct that have no matching column keep their zero value.
func Rows[T any](rows pgx.Rows, meta cache.StructMeta) ([]T, error) {
	defer rows.Close()

	// Build the column→field mapping once for this result set.

	var results []T
	for rows.Next() {
		mapping, dest := buildMapping[T](rows, meta)

		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("scan: row scan: %w", err)
		}

		t, err := applyDest[T](dest, mapping, meta)
		if err != nil {
			return nil, err
		}
		results = append(results, t)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("scan: rows iteration: %w", err)
	}

	return results, nil
}

// Row scans a single pgx.Row into T.
// Returns ErrNoRows (wrapping pgx.ErrNoRows) when no row was found.
func Row[T any](row pgx.Row, meta cache.StructMeta) (T, error) {
	var zero T

	dest := make([]any, len(meta.Fields))
	for i, f := range meta.Fields {
		dest[i] = newPtr(f.Type)
	}

	if err := row.Scan(dest...); err != nil {
		return zero, fmt.Errorf("scan: %w", err)
	}

	rv := reflect.New(reflect.TypeOf(zero)).Elem()
	for i, f := range meta.Fields {
		fv := f.FieldValue(rv)
		if !fv.CanSet() {
			continue
		}
		val := reflect.ValueOf(dest[i])
		if val.Kind() == reflect.Ptr {
			if val.IsNil() {
				continue
			}
			val = val.Elem()
		}
		if val.Type().AssignableTo(fv.Type()) {
			fv.Set(val)
		}
	}

	return rv.Interface().(T), nil
}

// ── internals ─────────────────────────────────────────────────────────────────

// colMapping maps a column position in the pgx result set → index in meta.Fields.
// -1 means the column has no matching field and should be skipped.
type colMapping []int

// buildMapping constructs the colMapping and a reusable dest slice.
// Called once per query, not once per row.
func buildMapping[T any](rows pgx.Rows, meta cache.StructMeta) (colMapping, []any) {
	descs := rows.FieldDescriptions()
	mapping := make(colMapping, len(descs))
	dest := make([]any, len(descs))

	for i, fd := range descs {
		col := string(fd.Name)
		fieldIdx := meta.ColumnIndex(col)
		mapping[i] = fieldIdx

		if fieldIdx >= 0 {
			dest[i] = newPtr(meta.Fields[fieldIdx].Type)
		} else {
			var sink any
			dest[i] = &sink
		}
	}

	return mapping, dest
}

// applyDest copies scanned values from dest into a new T using the mapping.
func applyDest[T any](dest []any, mapping colMapping, meta cache.StructMeta) (T, error) {
	var zero T
	rv := reflect.New(reflect.TypeOf(zero)).Elem()

	for colPos, fieldIdx := range mapping {
		if fieldIdx < 0 {
			continue
		}

		fv := meta.Fields[fieldIdx].FieldValue(rv)
		if !fv.CanSet() {
			continue
		}

		val := reflect.ValueOf(dest[colPos])
		if val.Kind() == reflect.Ptr {
			if val.IsNil() {
				continue
			}
			val = val.Elem()
		}

		if !val.Type().AssignableTo(fv.Type()) {
			return zero, fmt.Errorf(
				"scan: column %d: cannot assign %s to %s",
				colPos, val.Type(), fv.Type(),
			)
		}
		fv.Set(val)
	}

	return rv.Interface().(T), nil
}

// newPtr returns a pointer to a zero value of the given type.
// pgx requires scanning into pointers so it can handle NULLs.
func newPtr(t reflect.Type) any {
	// For pointer fields (e.g. *time.Time for soft-delete), pgx expects **T
	// so it can set the outer pointer to nil on NULL. We allocate one extra
	// level of indirection.
	if t.Kind() == reflect.Ptr {
		return reflect.New(t).Interface() // **T
	}
	return reflect.New(t).Interface() // *T
}
