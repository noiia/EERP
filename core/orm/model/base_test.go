package model_test

import (
	"testing"

	"core/orm/internal/cache"
	"core/orm/model"
)

// concreteEntity embeds BaseModel to simulate a real ERP entity.
type concreteEntity struct {
	model.BaseModel
	Name string `db:"name"`
}

func TestBaseModel_EmbeddedMeta(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[concreteEntity]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// PK must be inherited from BaseModel.
	if meta.PK != "id" {
		t.Errorf("PK = %q, want %q", meta.PK, "id")
	}

	// Expect: id, created_at, updated_at, deleted_at, name = 5 fields.
	if len(meta.Fields) != 5 {
		t.Errorf("Fields len = %d, want 5", len(meta.Fields))
	}
}

func TestBaseModel_SoftDeleteField(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[concreteEntity]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sd, ok := meta.SoftDeleteField()
	if !ok {
		t.Fatal("expected a soft-delete field from BaseModel embedding")
	}
	if sd.Column != "deleted_at" {
		t.Errorf("soft-delete column = %q, want %q", sd.Column, "deleted_at")
	}
}

func TestBaseModel_WritableColumns_ExcludesPK(t *testing.T) {
	t.Parallel()

	meta, err := cache.Get[concreteEntity]()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, col := range meta.WritableColumns() {
		if col == "id" {
			t.Error("WritableColumns must not contain the PK column")
		}
	}
}
