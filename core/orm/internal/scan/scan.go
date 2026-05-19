// Package scan maps pgx query results onto typed Go structs.
//
// Core design: always scan into *any.
//
// pgx decodes each column into the most natural Go type for the wire format
// it receives (time.Time for TIMESTAMPTZ, string for TEXT, etc.) and stores
// it inside the any. We then copy from any → struct field via reflect.
// This avoids every OID/format mismatch — pgx never needs to know the
// target Go type upfront.
//
// Column ordering: Rows uses FieldDescriptions() for correct name-based
// mapping regardless of column order. Row uses the same approach by
// wrapping the single row result — never assumes declaration order.
package scan

import (
	"fmt"
	"reflect"

	"core/orm/internal/cache"

	"github.com/jackc/pgx/v5"
)

// Rows scans all rows into a []T slice.
// Closes rows before returning — callers must not call rows.Close().
func Rows[T any](rows pgx.Rows, meta cache.StructMeta) ([]T, error) {
	defer rows.Close()

	mapping := buildMapping(rows, meta)
	n := len(mapping)

	var results []T
	for rows.Next() {
		dest := makeAnyDest(n)
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
//
// pgx.Row does not expose FieldDescriptions, so we cannot determine column
// order from it. Instead we scan all fields positionally using the number of
// fields in meta, then rely on the caller using column-ordered SQL
// (SELECT col1, col2... or RETURNING col1, col2...) that matches meta.Fields.
//
// For RETURNING * queries the column order is the physical table order which
// may differ from meta.Fields order. Callers that need guaranteed column
// mapping should use explicit RETURNING col1, col2... in declaration order,
// or use a Query (Rows) path which has FieldDescriptions available.
//
// Returns an error wrapping pgx.ErrNoRows when no row was found.
func Row[T any](row pgx.Row, meta cache.StructMeta) (T, error) {
	var zero T

	// Scan into as many *any slots as there are fields.
	// The identity mapping (colPos == fieldIdx) is intentional — it requires
	// the SQL to return columns in the same order as meta.Fields.
	// All ORM-generated SQL (InsertBuilder, UpdateBuilder, SelectBuilder)
	// lists columns explicitly in meta.Fields order, so this is safe.
	n := len(meta.Fields)
	mapping := make(colMapping, n)
	for i := range mapping {
		mapping[i] = i
	}

	dest := makeAnyDest(n)
	if err := row.Scan(dest...); err != nil {
		return zero, fmt.Errorf("scan: %w", err)
	}
	return applyDest[T](dest, mapping, meta)
}

// RowFromRows scans the first row from a pgx.Rows result into T and closes rows.
// Uses FieldDescriptions for correct name-based column mapping — safe with
// RETURNING * and any column order, unlike Row which requires declaration order.
// Returns an error wrapping pgx.ErrNoRows when no row was found.
func RowFromRows[T any](rows pgx.Rows, meta cache.StructMeta) (T, error) {
	results, err := Rows[T](rows, meta)
	if err != nil {
		var zero T
		return zero, err
	}
	if len(results) == 0 {
		var zero T
		return zero, fmt.Errorf("scan: %w", pgx.ErrNoRows)
	}
	return results[0], nil
}

// ── internals ─────────────────────────────────────────────────────────────────

// colMapping maps column position in result → index in meta.Fields.
// -1 means no matching struct field (column silently skipped).
type colMapping []int

func buildMapping(rows pgx.Rows, meta cache.StructMeta) colMapping {
	descs := rows.FieldDescriptions()
	m := make(colMapping, len(descs))
	for i, fd := range descs {
		m[i] = meta.ColumnIndex(string(fd.Name))
	}
	return m
}

// makeAnyDest builds a []any of *any pointers.
// pgx writes the decoded value into *any without needing type information.
func makeAnyDest(n int) []any {
	dest := make([]any, n)
	for i := range dest {
		var v any
		dest[i] = &v
	}
	return dest
}

// applyDest copies values from the scanned *any slice into a new T.
func applyDest[T any](dest []any, mapping colMapping, meta cache.StructMeta) (T, error) {
	var zero T
	rv := reflect.New(reflect.TypeOf(zero)).Elem()

	for colPos, fieldIdx := range mapping {
		if fieldIdx < 0 {
			continue
		}

		f := meta.Fields[fieldIdx]
		fv := f.FieldValue(rv)
		if !fv.CanSet() {
			continue
		}

		// Unwrap *any → the value pgx decoded.
		ptr, ok := dest[colPos].(*any)
		if !ok || ptr == nil || *ptr == nil {
			// NULL — leave field at zero value (nil for pointer fields).
			continue
		}
		raw := *ptr

		if err := assignToField(fv, raw, f); err != nil {
			return zero, fmt.Errorf("scan: field %q: %w", f.Column, err)
		}
	}

	return rv.Interface().(T), nil
}

// assignToField writes raw (decoded by pgx) into fv (the struct field).
func assignToField(fv reflect.Value, raw any, f cache.FieldMeta) error {
	src := reflect.ValueOf(raw)
	dstType := fv.Type()

	// Case 1: struct field is a pointer (e.g. *time.Time, *string).
	if dstType.Kind() == reflect.Ptr {
		elemType := dstType.Elem()
		if !src.Type().AssignableTo(elemType) && !src.Type().ConvertibleTo(elemType) {
			return fmt.Errorf("cannot assign %s to %s", src.Type(), dstType)
		}
		ptr := reflect.New(elemType)
		if src.Type().AssignableTo(elemType) {
			ptr.Elem().Set(src)
		} else {
			ptr.Elem().Set(src.Convert(elemType))
		}
		fv.Set(ptr)
		return nil
	}

	// Case 2: direct assignment.
	if src.Type().AssignableTo(dstType) {
		fv.Set(src)
		return nil
	}

	// Case 3: convertible (e.g. int64 → int, [16]byte → uuid.UUID).
	if src.Type().ConvertibleTo(dstType) {
		fv.Set(src.Convert(dstType))
		return nil
	}

	return fmt.Errorf("cannot assign %s to %s", src.Type(), dstType)
}
