package orm

import (
	"reflect"
	"time"

	"core/orm/internal/registry"

	"github.com/google/uuid"
)

// MigrationField describes one column in terms needed for DDL.
// Derived from a registered struct's reflection metadata.
type MigrationField struct {
	Column   string
	SQLType  string
	Nullable bool
	IsPK     bool
	SoftDel  bool
	// Index, when true, requests a secondary index on this column.
	// IndexType is the PostgreSQL index method (btree, hash, gin, …);
	// empty means btree.
	Index     bool
	IndexType string
}

// RegisteredTableNames returns the names of all currently registered
// (non-excluded) tables. Used by the module loader to find newly added tables.
func RegisteredTableNames() []string {
	all := registry.All()
	names := make([]string, len(all))
	for i, m := range all {
		names[i] = m.TableName
	}
	return names
}

// MigrationFieldsForTable returns the column DDL descriptors for a registered
// table, derived from the struct's reflect.Type metadata.
// Returns false when the table has not been registered yet.
func MigrationFieldsForTable(tableName string) ([]MigrationField, bool) {
	meta, ok := registry.Get(tableName)
	if !ok {
		return nil, false
	}

	fields := make([]MigrationField, len(meta.StructMeta.Fields))
	for i, f := range meta.StructMeta.Fields {
		fields[i] = MigrationField{
			Column:    f.Column,
			SQLType:   reflectTypeToSQL(f.Type),
			Nullable:  f.Type != nil && f.Type.Kind() == reflect.Ptr,
			IsPK:      f.IsPK,
			SoftDel:   f.SoftDel,
			Index:     f.Index,
			IndexType: f.IndexType,
		}
	}
	return fields, true
}

// reflectTypeToSQL maps a Go reflect.Type to its PostgreSQL column type.
func reflectTypeToSQL(t reflect.Type) string {
	if t == nil {
		return "TEXT"
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	switch t {
	case reflect.TypeOf(uuid.UUID{}):
		return "UUID"
	case reflect.TypeOf(time.Time{}):
		return "TIMESTAMPTZ"
	}
	switch t.Kind() {
	case reflect.String:
		return "TEXT"
	case reflect.Bool:
		return "BOOLEAN"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32:
		return "INTEGER"
	case reflect.Int64:
		return "BIGINT"
	case reflect.Float32:
		return "REAL"
	case reflect.Float64:
		return "DOUBLE PRECISION"
	default:
		return "TEXT"
	}
}
