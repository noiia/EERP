package cache

import "reflect"

// FieldMeta describes a single struct field mapped to a database column.
type FieldMeta struct {
	Name      string       // Go field name, e.g. "CreatedAt"
	Column    string       // resolved db column name, e.g. "created_at"
	IndexPath []int        // reflect path — handles promoted/embedded fields
	OmitEmpty bool         // db:"col,omitempty"
	IsPK      bool         // db:"col,pk"
	SoftDel   bool         // db:"col,softdelete"
	Type      reflect.Type // field's reflect.Type for fast type assertion
}

// StructMeta is the fully resolved metadata for one Go struct type.
// Built once, cached forever — never mutated after construction.
type StructMeta struct {
	Table  string      // resolved table name
	PK     string      // primary key column name, e.g. "id"
	Fields []FieldMeta // ordered list of all mapped fields

	// columnIndex maps column name → index in Fields slice for O(1) scan lookup.
	columnIndex map[string]int
}

// Columns returns the ordered list of column names (SELECT / INSERT).
func (m StructMeta) Columns() []string {
	cols := make([]string, len(m.Fields))
	for i, f := range m.Fields {
		cols[i] = f.Column
	}
	return cols
}

// ColumnIndex returns the Fields slice index for a given column name.
// Returns -1 if not found.
func (m StructMeta) ColumnIndex(col string) int {
	if idx, ok := m.columnIndex[col]; ok {
		return idx
	}
	return -1
}

// WritableColumns returns columns excluding the PK (INSERT / UPDATE).
func (m StructMeta) WritableColumns() []string {
	cols := make([]string, 0, len(m.Fields))
	for _, f := range m.Fields {
		if !f.IsPK {
			cols = append(cols, f.Column)
		}
	}
	return cols
}

// SoftDeleteField returns the FieldMeta for the soft-delete column, if any.
func (m StructMeta) SoftDeleteField() (FieldMeta, bool) {
	for _, f := range m.Fields {
		if f.SoftDel {
			return f, true
		}
	}
	return FieldMeta{}, false
}

// FieldValue extracts the reflect.Value for this field from a struct value.
// Uses IndexPath so promoted/embedded fields resolve correctly.
func (f FieldMeta) FieldValue(v reflect.Value) reflect.Value {
	return v.FieldByIndex(f.IndexPath)
}

// newStructMeta constructs a StructMeta and pre-builds the columnIndex.
func newStructMeta(table, pk string, fields []FieldMeta) StructMeta {
	idx := make(map[string]int, len(fields))
	for i, f := range fields {
		idx[f.Column] = i
	}
	return StructMeta{
		Table:       table,
		PK:          pk,
		Fields:      fields,
		columnIndex: idx,
	}
}
