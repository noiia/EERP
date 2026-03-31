package cache_test

import (
	"reflect"
	"testing"
	"time"

	"core/orm/internal/cache"
)

// ── Fixtures ──────────────────────────────────────────────────────────────────

type simpleModel struct {
	ID   int    `db:"id,pk"`
	Name string `db:"name"`
	Age  int    `db:"age,omitempty"`
}

type softModel struct {
	ID        int        `db:"id,pk"`
	Email     string     `db:"email"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
}

type tablerModel struct {
	ID    int    `db:"id,pk"`
	Label string `db:"label"`
}

func (tablerModel) TableName() string { return "custom_table" }

type noTagModel struct {
	UserID    int
	FirstName string
	LastName  string
}

type embeddedBase struct {
	ID        int        `db:"id,pk"`
	CreatedAt time.Time  `db:"created_at"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
}

type orderModel struct {
	embeddedBase
	CustomerID int    `db:"customer_id"`
	Status     string `db:"status"`
}

type ignoredField struct {
	ID      int    `db:"id,pk"`
	Name    string `db:"name"`
	Ignored string `db:"-"`
	private string //nolint:unused
}

// ── toSnake ───────────────────────────────────────────────────────────────────

func TestToSnake(t *testing.T) {
	t.Parallel()

	cases := []struct {
		in   string
		want string
	}{
		{"ID", "id"},
		{"UserID", "user_id"},
		{"FirstName", "first_name"},
		{"OrderLine", "order_line"},
		{"HTTPSPort", "https_port"},
		{"CreatedAt", "created_at"},
		{"DeletedAt", "deleted_at"},
		{"simple", "simple"},
	}
	for _, c := range cases {
		got := cache.ToSnake(c.in)
		if got != c.want {
			t.Errorf("ToSnake(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ── Get / build ───────────────────────────────────────────────────────────────

func TestGet_SimpleModel(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[simpleModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.Table != "simple_model" {
		t.Errorf("Table = %q, want %q", meta.Table, "simple_model")
	}
	if meta.PK != "id" {
		t.Errorf("PK = %q, want %q", meta.PK, "id")
	}
	if len(meta.Fields) != 3 {
		t.Errorf("Fields len = %d, want 3", len(meta.Fields))
	}
}

func TestGet_CustomTableName(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[tablerModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.Table != "custom_table" {
		t.Errorf("Table = %q, want %q", meta.Table, "custom_table")
	}
}

func TestGet_NoTagModel_SnakeCase(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[noTagModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	cols := meta.Columns()
	want := []string{"user_id", "first_name", "last_name"}
	for i, c := range want {
		if cols[i] != c {
			t.Errorf("Columns[%d] = %q, want %q", i, cols[i], c)
		}
	}
}

func TestGet_EmbeddedStruct(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[orderModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.PK != "id" {
		t.Errorf("PK = %q, want inherited %q", meta.PK, "id")
	}
	// id, created_at, deleted_at (from embeddedBase) + customer_id, status = 5
	if len(meta.Fields) != 5 {
		t.Errorf("Fields len = %d, want 5 (got columns: %v)", len(meta.Fields), meta.Columns())
	}
}

func TestGet_EmbeddedStruct_ColumnOrder(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[orderModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// VisibleFields breadth-first: embedded fields promoted before own fields.
	want := []string{"id", "created_at", "deleted_at", "customer_id", "status"}
	cols := meta.Columns()
	for i, c := range want {
		if i >= len(cols) {
			t.Fatalf("Columns too short, missing %q", c)
		}
		if cols[i] != c {
			t.Errorf("Columns[%d] = %q, want %q", i, cols[i], c)
		}
	}
}

func TestGet_IgnoredField(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[ignoredField]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, f := range meta.Fields {
		if f.Name == "Ignored" {
			t.Error("field tagged db:\"-\" must not appear in Fields")
		}
		if f.Name == "private" {
			t.Error("unexported field must not appear in Fields")
		}
	}
}

func TestGet_OmitEmpty(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[simpleModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, f := range meta.Fields {
		if f.Column == "age" && !f.OmitEmpty {
			t.Error("age field should have OmitEmpty=true")
		}
	}
}

func TestGet_SoftDelete(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[softModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sd, ok := meta.SoftDeleteField()
	if !ok {
		t.Fatal("expected a soft-delete field")
	}
	if sd.Column != "deleted_at" {
		t.Errorf("SoftDeleteField.Column = %q, want %q", sd.Column, "deleted_at")
	}
}

func TestGet_Cached_SamePointer(t *testing.T) {
	t.Parallel()

	m1, _ := cache.Get[simpleModel]()
	m2, _ := cache.Get[simpleModel]()
	// Identical Fields slice pointer proves the sync.Map returned the same value.
	if &m1.Fields[0] != &m2.Fields[0] {
		t.Error("expected same cached Fields slice pointer on second Get")
	}
}

// ── StructMeta helpers ────────────────────────────────────────────────────────

func TestStructMeta_Columns(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[simpleModel]()
	if len(meta.Columns()) != 3 {
		t.Fatalf("Columns len = %d, want 3", len(meta.Columns()))
	}
}

func TestStructMeta_WritableColumns_ExcludesPK(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[simpleModel]()
	for _, c := range meta.WritableColumns() {
		if c == "id" {
			t.Error("WritableColumns must not include the PK column")
		}
	}
}

func TestStructMeta_ColumnIndex_HitAndMiss(t *testing.T) {
	t.Parallel()

	meta, _ := cache.Get[simpleModel]()
	if meta.ColumnIndex("name") < 0 {
		t.Error("ColumnIndex(\"name\") returned -1, want valid index")
	}
	if meta.ColumnIndex("nonexistent") != -1 {
		t.Error("ColumnIndex(nonexistent) should return -1")
	}
}

// ── FieldMeta.FieldValue — embedded IndexPath resolution ─────────────────────

func TestFieldMeta_FieldValue_Embedded(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[orderModel]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	o := orderModel{CustomerID: 99, Status: "open"}
	rv := reflect.ValueOf(o)

	for _, f := range meta.Fields {
		val := f.FieldValue(rv)
		if !val.IsValid() {
			t.Errorf("FieldValue for column %q returned invalid reflect.Value", f.Column)
		}
	}

	// Spot-check promoted field value.
	for _, f := range meta.Fields {
		if f.Column == "customer_id" {
			got := f.FieldValue(rv).Int()
			if got != 99 {
				t.Errorf("customer_id FieldValue = %d, want 99", got)
			}
		}
	}
}

// ── Error cases ───────────────────────────────────────────────────────────────

func TestGet_NonStruct_ReturnsError(t *testing.T) {
	t.Parallel()

	_, err := cache.Global.Get(cache.ReflectTypeOf[int]())
	if err == nil {
		t.Error("expected error for non-struct type, got nil")
	}
}
