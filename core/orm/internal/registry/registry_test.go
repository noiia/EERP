package registry_test

import (
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"core/orm/internal/registry"
	"core/orm/model"

	"github.com/google/uuid"
)

// ── test fixtures ─────────────────────────────────────────────────────────────

type product struct {
	model.BaseModel
	Name         string  `db:"name"`
	Price        float64 `db:"price"`
	InternalCost float64 `db:"internal_cost"`
}

type hardEntity struct {
	ID   uuid.UUID `db:"id,pk"`
	Code string    `db:"code"`
}

type noTagsStruct struct {
	Foo string
	Bar int
}

// ── helpers ───────────────────────────────────────────────────────────────────

// resetRegistry clears the global state between tests.
// Accesses the internal registry using the test-only Reset function.
func resetRegistry() {
	registry.Reset()
}

// writeTempYAML writes yaml content to a temp file and returns its path.
func writeTempYAML(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "api*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return f.Name()
}

// ── tests ─────────────────────────────────────────────────────────────────────

func TestRegister_BuildsCorrectTableName(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, ok := registry.Get("product")
	if !ok {
		t.Fatal("expected 'product' in registry")
	}
	if meta.TableName != "product" {
		t.Errorf("TableName = %q, want %q", meta.TableName, "product")
	}
}

func TestRegister_WithTableName_OverridesDefault(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](registry.WithTableName("products")); err != nil {
		t.Fatalf("Register: %v", err)
	}
	_, ok := registry.Get("product")
	if ok {
		t.Error("default table name should not be present")
	}
	meta, ok := registry.Get("products")
	if !ok {
		t.Fatal("expected 'products' in registry")
	}
	if meta.TableName != "products" {
		t.Errorf("TableName = %q, want %q", meta.TableName, "products")
	}
}

func TestRegister_WithReadOnlyFields(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](registry.WithReadOnlyFields("id", "created_at")); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	for _, f := range meta.Fields {
		if (f.Column == "id" || f.Column == "created_at") && !f.ReadOnly {
			t.Errorf("field %q should be read-only", f.Column)
		}
		if f.Column == "name" && f.ReadOnly {
			t.Error("field 'name' should NOT be read-only")
		}
	}
}

func TestRegister_WithExcludeFields(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](registry.WithExcludeFields("internal_cost")); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	for _, f := range meta.Fields {
		if f.Column == "internal_cost" {
			t.Error("internal_cost should be excluded")
		}
	}
}

func TestRegister_SoftDelete_DetectedFromDeletedAt(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	if !meta.SoftDelete {
		t.Error("product embeds BaseModel with *time.Time DeletedAt — SoftDelete should be true")
	}
}

func TestRegister_HardEntity_NoSoftDelete(t *testing.T) {
	resetRegistry()
	if err := registry.Register[hardEntity](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("hard_entity")
	if meta.SoftDelete {
		t.Error("hardEntity has no DeletedAt — SoftDelete should be false")
	}
}

func TestRegister_PKField_PopulatedCorrectly(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	if meta.PKField.Column != "id" {
		t.Errorf("PKField.Column = %q, want %q", meta.PKField.Column, "id")
	}
}

func TestRegister_TypeRef_IsCorrectType(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	want := reflect.TypeOf(product{})
	if meta.TypeRef != want {
		t.Errorf("TypeRef = %v, want %v", meta.TypeRef, want)
	}
}

func TestWithExcluded_KeepsTableOffHTTPSurface(t *testing.T) {
	resetRegistry()

	if err := registry.Register[product](registry.WithExcluded()); err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Not in All() (BuildHandlers iterates All(), so no routes mounted)...
	for _, m := range registry.All() {
		if m.TableName == "product" {
			t.Error("code-excluded table should not appear in All()")
		}
	}
	// ...but still registered with the ORM (typed repo / migrations use Get()).
	meta, ok := registry.Get("product")
	if !ok {
		t.Fatal("code-excluded table should still be registered")
	}
	if !meta.Excluded {
		t.Error("Excluded should be true")
	}
}

func TestLoadAPIConfig_FailsClosedOnMalformedYAML(t *testing.T) {
	resetRegistry()

	path := writeTempYAML(t, "tables: [this is not a map")
	if err := registry.LoadAPIConfig(path); err == nil {
		t.Fatal("malformed api.yaml must return an error, not silently drop overrides")
	}
}

func TestLoadAPIConfig_FailsClosedOnMissingFile(t *testing.T) {
	resetRegistry()

	if err := registry.LoadAPIConfig(t.TempDir() + "/does-not-exist.yaml"); err == nil {
		t.Fatal("missing configured api.yaml must return an error")
	}
}

func TestAll_ExcludesExcludedTables(t *testing.T) {
	resetRegistry()

	yaml := writeTempYAML(t, `
tables:
  product:
    exclude: true
`)
	if err := registry.LoadAPIConfig(yaml); err != nil {
		t.Fatal(err)
	}

	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}

	all := registry.All()
	for _, m := range all {
		if m.TableName == "product" {
			t.Error("excluded table should not appear in All()")
		}
	}
}

func TestGet_ReturnsExcludedTable(t *testing.T) {
	resetRegistry()

	yaml := writeTempYAML(t, `
tables:
  product:
    exclude: true
`)
	if err := registry.LoadAPIConfig(yaml); err != nil {
		t.Fatal(err)
	}

	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}

	meta, ok := registry.Get("product")
	if !ok {
		t.Fatal("Get should return excluded table")
	}
	if !meta.Excluded {
		t.Error("Excluded should be true")
	}
}

func TestAPIYAML_ReadOnlyOverride(t *testing.T) {
	resetRegistry()

	yaml := writeTempYAML(t, `
tables:
  product:
    read_only_fields: [id, created_at, updated_at]
`)
	if err := registry.LoadAPIConfig(yaml); err != nil {
		t.Fatal(err)
	}

	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}

	meta, _ := registry.Get("product")
	for _, f := range meta.Fields {
		if (f.Column == "id" || f.Column == "created_at" || f.Column == "updated_at") && !f.ReadOnly {
			t.Errorf("field %q should be read-only via api.yaml", f.Column)
		}
	}
}

func TestAPIYAML_ExcludeFields(t *testing.T) {
	resetRegistry()

	yaml := writeTempYAML(t, `
tables:
  product:
    exclude_fields: [internal_cost]
`)
	if err := registry.LoadAPIConfig(yaml); err != nil {
		t.Fatal(err)
	}

	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}

	meta, _ := registry.Get("product")
	for _, f := range meta.Fields {
		if f.Column == "internal_cost" {
			t.Error("internal_cost should be excluded via api.yaml")
		}
	}
}

func TestAPIYAML_RoutePrefix(t *testing.T) {
	resetRegistry()

	yaml := writeTempYAML(t, `
tables:
  product:
    route_prefix: items
`)
	if err := registry.LoadAPIConfig(yaml); err != nil {
		t.Fatal(err)
	}

	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}

	meta, _ := registry.Get("product")
	if meta.RoutePrefix != "items" {
		t.Errorf("RoutePrefix = %q, want %q", meta.RoutePrefix, "items")
	}
}

func TestAutoScan_IsNoOp(t *testing.T) {
	resetRegistry()
	if err := registry.AutoScan("some/package/path"); err != nil {
		t.Errorf("AutoScan should return nil, got %v", err)
	}
	if len(registry.All()) != 0 {
		t.Error("AutoScan should not register anything")
	}
}

func TestRegister_NullableFields(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	for _, f := range meta.Fields {
		if f.Column == "deleted_at" && !f.Nullable {
			t.Error("deleted_at is *time.Time — Nullable should be true")
		}
		if f.Column == "name" && f.Nullable {
			t.Error("name is string — Nullable should be false")
		}
	}
}

func TestRegister_GoTypeName(t *testing.T) {
	resetRegistry()
	if err := registry.Register[product](); err != nil {
		t.Fatalf("Register: %v", err)
	}
	meta, _ := registry.Get("product")
	for _, f := range meta.Fields {
		switch f.Column {
		case "name":
			if f.GoType != "string" {
				t.Errorf("name GoType = %q, want %q", f.GoType, "string")
			}
		case "deleted_at":
			if f.GoType != "*time.Time" {
				t.Errorf("deleted_at GoType = %q, want %q", f.GoType, "*time.Time")
			}
		case "created_at":
			if f.GoType != "time.Time" {
				t.Errorf("created_at GoType = %q, want %q", f.GoType, "time.Time")
			}
		}
	}
}

// Verify unused imported packages don't cause compiler errors.
var (
	_ = time.Now
	_ = uuid.New
	_ sync.Once
)
