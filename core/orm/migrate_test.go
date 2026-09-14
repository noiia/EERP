package orm_test

import (
	"testing"

	"core/orm"
	"core/orm/model"
)

// jsonbFixture proves a slice-typed field (e.g. sale.Invoice's Lines, an
// array of line-item objects the invoice PDF report table renders) migrates
// as JSONB rather than falling through reflectTypeToSQL's TEXT default —
// the one gap that stood between the generic CRUD's already-dynamic
// map[string]any read/write path (orm/internal/crud) and actually storing a
// module's own array-valued column.
type jsonbFixture struct {
	model.BaseModel
	Lines *[]map[string]any `db:"lines"`
}

func TestMigrationFieldsForTable_SliceFieldIsJSONB(t *testing.T) {
	if err := orm.Register[jsonbFixture](); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("jsonb_fixture")
	if !ok {
		t.Fatal("jsonb_fixture table not registered")
	}

	for _, f := range fields {
		if f.Column != "lines" {
			continue
		}
		if f.SQLType != "JSONB" {
			t.Errorf("lines SQLType = %q, want JSONB", f.SQLType)
		}
		if !f.Nullable {
			t.Error("lines should be nullable (pointer-to-slice, same convention as every other optional column)")
		}
		return
	}
	t.Fatal("lines column not found in migration fields")
}
