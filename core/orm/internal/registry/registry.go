// Package registry maps registered Go structs to TableMeta descriptors used by
// the generic CRUD and handler layers. It reads metadata from the cache — it
// never calls reflect.VisibleFields or any other reflection itself.
package registry

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"

	"core/orm/internal/cache"

	"gopkg.in/yaml.v3"
)

// FieldMeta describes one API-visible column.
type FieldMeta struct {
	Name      string // JSON key (defaults to Column; overridable via api.yaml)
	Column    string // DB column name from db tag
	GoType    string // human-readable Go type, e.g. "string", "uuid.UUID", "*time.Time"
	Nullable  bool   // true when the field is a pointer type
	ReadOnly  bool   // true when marked read-only via Option or api.yaml
	IndexPath []int  // FieldByIndex path, from cache.FieldMeta
}

// TableMeta is the fully resolved descriptor for one registered struct.
type TableMeta struct {
	TableName   string        // snake_case table name
	RoutePrefix string        // URL segment, e.g. "products" → /api/v1/products
	Fields      []FieldMeta   // all API-visible fields
	PKField     FieldMeta     // the primary key field
	SoftDelete  bool          // true when any field carries the softdelete tag
	Excluded    bool          // true when api.yaml marks this table exclude: true
	TypeRef     reflect.Type  // for instantiating values at runtime
	StructMeta  cache.StructMeta // passed to query builders by the crud layer
}

// HasField returns true when the table has a column named col.
func (m TableMeta) HasField(col string) bool {
	for _, f := range m.Fields {
		if f.Column == col {
			return true
		}
	}
	return false
}

// ── Options ───────────────────────────────────────────────────────────────────

// Option configures a Register call.
type Option func(*regOptions)

type regOptions struct {
	tableName    string
	readOnly     []string
	excludeCols  []string
	excluded     bool
}

// WithTableName overrides the table name derived from the struct name.
func WithTableName(name string) Option {
	return func(o *regOptions) { o.tableName = name }
}

// WithReadOnlyFields marks the named columns as read-only in the API.
// Read-only fields are stripped from POST/PUT request bodies.
func WithReadOnlyFields(fields ...string) Option {
	return func(o *regOptions) { o.readOnly = append(o.readOnly, fields...) }
}

// WithExcludeFields removes the named columns from the API entirely.
func WithExcludeFields(fields ...string) Option {
	return func(o *regOptions) { o.excludeCols = append(o.excludeCols, fields...) }
}

// WithExcluded keeps the table off the HTTP surface entirely: it is still
// registered with the ORM (typed repos, migrations) but BuildHandlers mounts no
// CRUD routes for it. This is the code-level, fail-closed equivalent of the
// api.yaml `exclude: true` knob — use it for internal tables (e.g. refresh
// tokens) whose exposure would be a security issue, so the guarantee cannot be
// lost by a missing or malformed override file.
func WithExcluded() Option {
	return func(o *regOptions) { o.excluded = true }
}

// ── Global registry ───────────────────────────────────────────────────────────

var (
	mu      sync.RWMutex
	entries = map[string]TableMeta{}

	apiCfg     *apiConfig
	apiCfgOnce sync.Once
	apiCfgPath = "api.yaml" // overridden by LoadAPIConfig
	apiCfgMu   sync.Mutex
)

// Register builds and stores a TableMeta for T, applying any Options and any
// overrides from the loaded api.yaml.
func Register[T any](opts ...Option) error {
	// Resolve reflect.Type for T.
	var zero T
	t := reflect.TypeOf(zero)
	if t == nil {
		t = reflect.TypeOf((*T)(nil)).Elem()
	}
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	sm, err := cache.Get[T]()
	if err != nil {
		return fmt.Errorf("registry: get cache for %T: %w", zero, err)
	}

	o := &regOptions{}
	for _, opt := range opts {
		opt(o)
	}

	meta := buildFromCache(t, sm, o)
	applyAPIConfig(&meta, ensureAPIConfig())

	mu.Lock()
	entries[meta.TableName] = meta
	mu.Unlock()
	return nil
}

// AutoScan is a no-op placeholder. Go does not support runtime package
// discovery in compiled binaries — use Register[T] for explicit registration.
func AutoScan(_ string) error { return nil }

// ExtendSchema appends extra columns to an already-registered table.
// Use this from an inheriting module to add fields to another module's entity
// without touching the base module's code.
// Returns an error if tableName has not been registered yet — ensure the base
// module's Register() runs before the inheriting module's (import it with _).
func ExtendSchema(tableName string, extra []SchemaField) error {
	mu.Lock()
	defer mu.Unlock()

	existing, ok := entries[tableName]
	if !ok {
		return fmt.Errorf("registry: extend: table %q is not registered", tableName)
	}

	existingCols := make(map[string]bool, len(existing.StructMeta.Fields))
	for _, f := range existing.StructMeta.Fields {
		existingCols[f.Column] = true
	}

	cacheFields := make([]cache.FieldMeta, len(existing.StructMeta.Fields))
	copy(cacheFields, existing.StructMeta.Fields)
	regFields := make([]FieldMeta, len(existing.Fields))
	copy(regFields, existing.Fields)

	for _, f := range extra {
		if existingCols[f.Column] {
			continue
		}
		cacheFields = append(cacheFields, cache.FieldMeta{
			Name:    f.Column,
			Column:  f.Column,
			IsPK:    f.IsPK,
			SoftDel: f.SoftDel,
		})
		regFields = append(regFields, FieldMeta{
			Name:     f.Column,
			Column:   f.Column,
			Nullable: f.Nullable,
			ReadOnly: f.IsPK,
		})
	}

	existing.StructMeta = cache.NewStructMeta(existing.TableName, existing.StructMeta.PK, cacheFields)
	existing.Fields = regFields
	entries[tableName] = existing
	return nil
}

// SchemaField describes one column for dynamic (non-reflect) registration.
type SchemaField struct {
	Column   string
	Nullable bool
	IsPK     bool
	SoftDel  bool
}

// RegisterSchema stores a TableMeta built entirely from runtime data.
// Use this for WASM-defined tables where no Go struct exists.
// The crud layer uses scanToMaps (column names from pgx descriptors), so
// IndexPath in the underlying FieldMeta is safe to leave nil.
func RegisterSchema(tableName string, fields []SchemaField) error {
	cacheFields := make([]cache.FieldMeta, len(fields))
	regFields := make([]FieldMeta, len(fields))
	var pkCol string
	var pkField FieldMeta
	hasSoftDel := false

	for i, f := range fields {
		cacheFields[i] = cache.FieldMeta{
			Name:    f.Column,
			Column:  f.Column,
			IsPK:    f.IsPK,
			SoftDel: f.SoftDel,
		}
		if f.IsPK {
			pkCol = f.Column
		}
		if f.SoftDel {
			hasSoftDel = true
		}
		rf := FieldMeta{
			Name:     f.Column,
			Column:   f.Column,
			Nullable: f.Nullable,
			ReadOnly: f.IsPK,
		}
		if f.IsPK {
			pkField = rf
		}
		regFields[i] = rf
	}

	sm := cache.NewStructMeta(tableName, pkCol, cacheFields)
	meta := TableMeta{
		TableName:   tableName,
		RoutePrefix: tableName,
		Fields:      regFields,
		PKField:     pkField,
		SoftDelete:  hasSoftDel,
		StructMeta:  sm,
	}
	applyAPIConfig(&meta, ensureAPIConfig())

	mu.Lock()
	entries[meta.TableName] = meta
	mu.Unlock()
	return nil
}

// All returns all registered, non-excluded TableMetas.
func All() []TableMeta {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]TableMeta, 0, len(entries))
	for _, m := range entries {
		if !m.Excluded {
			out = append(out, m)
		}
	}
	return out
}

// Get returns the TableMeta for the given table name (including excluded tables).
func Get(tableName string) (TableMeta, bool) {
	mu.RLock()
	defer mu.RUnlock()
	m, ok := entries[tableName]
	return m, ok
}

// LoadAPIConfig loads api.yaml from the given path, replacing any previously
// loaded overrides. Must be called before any Register calls that should see the
// overrides.
//
// Unlike the lazy default loader, this fails closed: a path that cannot be read
// or does not parse returns an error instead of silently dropping every override.
// Callers (main.go) must treat that error as fatal — a security control (field or
// table exclusion) that vanishes on a typo is worse than no file at all.
func LoadAPIConfig(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("registry: load api config %q: %w", path, err)
	}
	var cfg apiConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("registry: parse api config %q: %w", path, err)
	}
	// Consume the lazy loader so a later ensureAPIConfig call cannot re-read the
	// file or clobber this config. Done outside apiCfgMu because the once-func in
	// ensureAPIConfig also acquires apiCfgMu.
	apiCfgOnce.Do(func() {})
	apiCfgMu.Lock()
	apiCfgPath = path
	apiCfg = &cfg
	apiCfgMu.Unlock()
	return nil
}

// ── api.yaml ──────────────────────────────────────────────────────────────────

type apiConfig struct {
	Tables map[string]tableConfig `yaml:"tables"`
}

type tableConfig struct {
	ExcludeFields  []string `yaml:"exclude_fields"`
	ReadOnlyFields []string `yaml:"read_only_fields"`
	RoutePrefix    string   `yaml:"route_prefix"`
	Exclude        bool     `yaml:"exclude"`
}

func ensureAPIConfig() *apiConfig {
	apiCfgOnce.Do(func() {
		apiCfgMu.Lock()
		path := apiCfgPath
		apiCfgMu.Unlock()

		data, err := os.ReadFile(path)
		if err != nil {
			return // file absent — no overrides
		}
		var cfg apiConfig
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return // malformed yaml — silently skip
		}
		apiCfgMu.Lock()
		apiCfg = &cfg
		apiCfgMu.Unlock()
	})
	apiCfgMu.Lock()
	defer apiCfgMu.Unlock()
	return apiCfg
}

func applyAPIConfig(meta *TableMeta, cfg *apiConfig) {
	if cfg == nil {
		return
	}
	tc, ok := cfg.Tables[meta.TableName]
	if !ok {
		return
	}
	if tc.Exclude {
		meta.Excluded = true
		return
	}
	if tc.RoutePrefix != "" {
		meta.RoutePrefix = tc.RoutePrefix
	}
	excludeSet := toSet(tc.ExcludeFields)
	roSet := toSet(tc.ReadOnlyFields)

	filtered := meta.Fields[:0]
	for _, f := range meta.Fields {
		if excludeSet[f.Column] {
			continue
		}
		if roSet[f.Column] {
			f.ReadOnly = true
		}
		filtered = append(filtered, f)
	}
	meta.Fields = filtered
}

// ── Build helpers ─────────────────────────────────────────────────────────────

func buildFromCache(t reflect.Type, sm cache.StructMeta, o *regOptions) TableMeta {
	excludeSet := toSet(o.excludeCols)
	roSet := toSet(o.readOnly)

	fields := make([]FieldMeta, 0, len(sm.Fields))
	var pkField FieldMeta
	hasSoftDel := false

	for _, cf := range sm.Fields {
		if excludeSet[cf.Column] {
			continue
		}
		fm := FieldMeta{
			Name:      cf.Column,
			Column:    cf.Column,
			GoType:    goTypeName(cf.Type),
			Nullable:  cf.Type.Kind() == reflect.Ptr,
			ReadOnly:  roSet[cf.Column],
			IndexPath: cf.IndexPath,
		}
		if cf.IsPK {
			pkField = fm
		}
		if cf.SoftDel {
			hasSoftDel = true
		}
		fields = append(fields, fm)
	}

	tableName := sm.Table
	if o.tableName != "" {
		tableName = o.tableName
	}

	return TableMeta{
		TableName:   tableName,
		RoutePrefix: tableName,
		Fields:      fields,
		PKField:     pkField,
		SoftDelete:  hasSoftDel,
		Excluded:    o.excluded,
		TypeRef:     t,
		StructMeta:  sm,
	}
}

// goTypeName returns a human-readable type string, e.g. "string", "uuid.UUID", "*time.Time".
func goTypeName(t reflect.Type) string {
	if t.Kind() == reflect.Ptr {
		return "*" + goTypeName(t.Elem())
	}
	pkg := t.PkgPath()
	if pkg == "" {
		return t.Name()
	}
	parts := strings.Split(pkg, "/")
	return parts[len(parts)-1] + "." + t.Name()
}

func toSet(ss []string) map[string]bool {
	m := make(map[string]bool, len(ss))
	for _, s := range ss {
		m[s] = true
	}
	return m
}
