// Package scan maps pgx query results onto typed Go structs.
// It is the only package in the ORM that calls reflect at runtime —
// everything else is statically typed via generics.
//
// The hot path is:
//  1. pgx returns column names via rows.FieldDescriptions()
//  2. We build a one-time []int index mapping column position → Fields index
//  3. Each row is scanned into a fresh []any dest slice, then copied into the
//     struct via FieldMeta.FieldValue + reflect.Value.Set
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

	// Build the column→field mapping once for this entire result set.
	mapping := buildMapping(rows, meta)

	var results []T
	for rows.Next() {
		dest := buildDest(mapping, meta)

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

// Row scans a single pgx.Row into T using positional column order.
// The query must select columns in the same order as meta.Fields — this is
// guaranteed when using SelectBuilder (which lists columns explicitly) but
// NOT when using RETURNING *. For RETURNING *, use Rows instead.
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

// buildMapping constructs the colMapping from field descriptions.
// Call once per query result set, before the row-iteration loop.
func buildMapping(rows pgx.Rows, meta cache.StructMeta) colMapping {
	descs := rows.FieldDescriptions()
	mapping := make(colMapping, len(descs))
	for i, fd := range descs {
		mapping[i] = meta.ColumnIndex(string(fd.Name))
	}
	return mapping
}

// buildDest allocates a fresh dest slice for a single row scan.
// Called once per row — each row needs its own pointer targets.
func buildDest(mapping colMapping, meta cache.StructMeta) []any {
	dest := make([]any, len(mapping))
	for i, fieldIdx := range mapping {
		if fieldIdx >= 0 {
			dest[i] = newPtr(meta.Fields[fieldIdx].Type)
		} else {
			var sink any
			dest[i] = &sink
		}
	}
	return dest
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
	// so it can set the outer pointer to nil on NULL.
	if t.Kind() == reflect.Ptr {
		return reflect.New(t).Interface() // **T
	}
	return reflect.New(t).Interface() // *T
}
