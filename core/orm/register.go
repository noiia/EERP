package orm

import "core/orm/internal/registry"

// Option configures a Register call. Re-exported so callers only import core/orm.
type Option = registry.Option

// Register builds and stores an API descriptor for struct T.
// Must be called before server.BuildHandlers.
func Register[T any](opts ...registry.Option) error {
	return registry.Register[T](opts...)
}

// AutoScan is a no-op placeholder.
// Go compiled binaries cannot discover struct types in a package at runtime.
// Use Register[T] for explicit registration.
func AutoScan(pkgPath string) error {
	return registry.AutoScan(pkgPath)
}

// SchemaField is re-exported so callers only import core/orm.
type SchemaField = registry.SchemaField

// RegisterSchema stores a TableMeta built from runtime schema data.
// Use this for WASM-defined tables where no Go struct exists — loadModule
// calls this automatically, so modules never need to be listed in main.go.
func RegisterSchema(tableName string, fields []SchemaField) error {
	return registry.RegisterSchema(tableName, fields)
}

// ExtendSchema appends extra columns to an already-registered table's ORM entry.
// Call this from an inheriting module's Register() to add fields to another
// module's entity without modifying that module's code.
func ExtendSchema(tableName string, extra []SchemaField) error {
	return registry.ExtendSchema(tableName, extra)
}

// WithTableName overrides the table name derived from the struct name.
func WithTableName(name string) Option {
	return registry.WithTableName(name)
}

// WithReadOnlyFields marks the named columns as read-only in the API.
func WithReadOnlyFields(fields ...string) Option {
	return registry.WithReadOnlyFields(fields...)
}

// WithExcludeFields removes the named columns from the API.
func WithExcludeFields(fields ...string) Option {
	return registry.WithExcludeFields(fields...)
}

// WithFieldGroups gates the named columns (map: column -> groups) to callers
// whose resolved group set intersects. See registry.WithFieldGroups.
func WithFieldGroups(groups map[string][]string) Option {
	return registry.WithFieldGroups(groups)
}

// WithExcluded keeps the table registered with the ORM but off the HTTP surface
// (no CRUD routes). Code-level, fail-closed equivalent of api.yaml `exclude: true`.
func WithExcluded() Option {
	return registry.WithExcluded()
}

// LoadAPIConfig loads per-table overrides from a YAML file.
// Call before Register if you want api.yaml overrides to take effect.
func LoadAPIConfig(path string) error {
	return registry.LoadAPIConfig(path)
}
