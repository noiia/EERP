package sale

import (
	"context"
	"reflect"
	"testing"

	"core/internal/testdb"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func TestResolveTaxes(t *testing.T) {
	app := testdb.Open(t)
	if err := (&saleModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	testdb.Migrate(t, app, "sale_tax")

	ctx := context.Background()
	taxes := orm.MustRepo[SaleTax](app.DB)
	tenant := uuid.New()
	seed := func(name string) SaleTax {
		tax, err := taxes.Create(ctx, SaleTax{BaseModel: model.BaseModel{TenantID: tenant}, Name: name, Kind: "percentage", Rate: 0.1})
		if err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		t.Cleanup(func() { _, _ = taxes.HardDelete(ctx, tax.ID) })
		return tax
	}
	a, b := seed("a"), seed("b")
	deleted := seed("deleted")
	if _, err := taxes.Delete(ctx, deleted.ID); err != nil { // soft delete
		t.Fatalf("delete: %v", err)
	}

	tests := []struct {
		name string
		ids  []uuid.UUID
		want []string
	}{
		{"none", nil, nil},
		{"order kept", []uuid.UUID{b.ID, a.ID}, []string{"b", "a"}},
		{"duplicate link counted twice", []uuid.UUID{a.ID, a.ID}, []string{"a", "a"}},
		{"dangling and soft-deleted skipped", []uuid.UUID{uuid.New(), a.ID, deleted.ID}, []string{"a"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ResolveTaxes(ctx, taxes, tt.ids)
			if err != nil {
				t.Fatalf("ResolveTaxes: %v", err)
			}
			var names []string
			for _, tax := range got {
				names = append(names, tax.Name)
			}
			if !reflect.DeepEqual(names, tt.want) {
				t.Errorf("got %v, want %v", names, tt.want)
			}
		})
	}
}
