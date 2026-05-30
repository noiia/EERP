package cache

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// Tabler is the optional interface a model can implement to override
// the default snake_case table name derived from the struct name.
type Tabler interface {
	TableName() string
}

// MetadataCache builds and caches StructMeta per reflect.Type.
// sync.Map gives lock-free reads after the first warm-up — reflection
// only runs once per type for the lifetime of the process.
type MetadataCache struct {
	m sync.Map // map[reflect.Type]StructMeta
}

// Global singleton — one cache for the whole ORM.
var Global = &MetadataCache{}

// Get returns the StructMeta for T, building it on first access.
func Get[T any]() (StructMeta, error) {
	return Global.Get(typeOf[T]())
}

// Get returns the StructMeta for the given reflect.Type.
func (c *MetadataCache) Get(t reflect.Type) (StructMeta, error) {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return StructMeta{}, fmt.Errorf("cache: %s is not a struct", t.Name())
	}

	if v, ok := c.m.Load(t); ok {
		return v.(StructMeta), nil
	}

	meta, err := c.build(t)
	if err != nil {
		return StructMeta{}, err
	}

	c.m.LoadOrStore(t, meta)
	actual, _ := c.m.Load(t)
	return actual.(StructMeta), nil
}

// build runs reflection on t and returns a fully populated StructMeta.
//
// It uses reflect.VisibleFields which correctly flattens anonymous embedded
// structs into a single linear list — each entry carries its full Index path
// (e.g. [0, 2] for the third field of the first embedded struct).
// This is the only correct way to handle embedding: iterating t.NumField()
// directly only sees the top-level fields, missing promoted fields entirely.
func (c *MetadataCache) build(t reflect.Type) (StructMeta, error) {
	table := tableName(t)
	pk := "id"
	pkFound := false

	// reflect.VisibleFields walks the full promoted field tree in breadth-first
	// order, filtering out shadowed and unexported fields automatically.
	visible := reflect.VisibleFields(t)
	fields := make([]FieldMeta, 0, len(visible))

	for _, sf := range visible {
		if !sf.IsExported() {
			continue
		}
		// Skip the anonymous embedding entry itself — we want its promoted
		// children, which VisibleFields already includes in the flat list.
		if sf.Anonymous {
			continue
		}

		tag := sf.Tag.Get("db")
		if tag == "-" {
			continue
		}

		fm, err := parseField(sf, tag)
		if err != nil {
			return StructMeta{}, fmt.Errorf("cache: field %s.%s: %w", t.Name(), sf.Name, err)
		}

		if fm.IsPK {
			pk = fm.Column
			pkFound = true
		}

		fields = append(fields, fm)
	}

	if len(fields) == 0 {
		return StructMeta{}, fmt.Errorf("cache: struct %s has no mapped fields", t.Name())
	}

	// If no explicit pk tag, fall back to a field whose column name is "id".
	if !pkFound {
		for i, f := range fields {
			if f.Column == "id" {
				fields[i].IsPK = true
				pk = "id"
				break
			}
		}
	}

	return newStructMeta(table, pk, fields), nil
}

// parseField converts a reflect.StructField + raw tag into a FieldMeta.
// sf.Index is stored as IndexPath for nested access via reflect.Value.FieldByIndex.
func parseField(sf reflect.StructField, tag string) (FieldMeta, error) {
	fm := FieldMeta{
		Name:      sf.Name,
		IndexPath: sf.Index,
		Type:      sf.Type,
	}

	col := tag
	if col == "" {
		fm.Column = toSnake(sf.Name)
		return fm, nil
	}

	parts := strings.Split(col, ",")
	col = parts[0]
	for _, opt := range parts[1:] {
		switch strings.TrimSpace(opt) {
		case "omitempty":
			fm.OmitEmpty = true
		case "pk":
			fm.IsPK = true
		case "softdelete":
			fm.SoftDel = true
		}
	}

	if col == "" {
		col = toSnake(sf.Name)
	}

	fm.Column = col
	return fm, nil
}

// tableName resolves the table name for a struct type.
func tableName(t reflect.Type) string {
	v := reflect.New(t).Interface()
	if tb, ok := v.(Tabler); ok {
		return tb.TableName()
	}
	return toSnake(t.Name())
}

// ReflectTypeOf is the exported form of typeOf, used in tests.
func ReflectTypeOf[T any]() reflect.Type { return typeOf[T]() }

// ToSnake is exported so tests can verify the conversion directly.
var ToSnake = toSnake

// typeOf returns the reflect.Type of T without requiring a value.
func typeOf[T any]() reflect.Type {
	var zero T
	t := reflect.TypeOf(zero)
	if t == nil {
		t = reflect.TypeOf((*T)(nil)).Elem()
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	return t
}

// toSnake converts CamelCase to snake_case.
// "OrderLine" → "order_line", "ID" → "id", "HTTPSPort" → "https_port".
func toSnake(s string) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 4)
	for i, r := range s {
		upper := r >= 'A' && r <= 'Z'
		if upper && i > 0 {
			prev := rune(s[i-1])
			nextLower := i+1 < len(s) && s[i+1] >= 'a' && s[i+1] <= 'z'
			prevLower := prev >= 'a' && prev <= 'z'
			if prevLower || nextLower {
				b.WriteByte('_')
			}
		}
		if upper {
			b.WriteRune(r + 32)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}
