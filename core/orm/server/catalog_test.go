package server_test

import (
	"context"
	"testing"

	"core/orm"
	"core/orm/access"
	"core/orm/model"
	ormserver "core/orm/server"
)

type catalogRecord struct {
	model.BaseModel
	Name     string `db:"name"`
	Secret   string `db:"secret"`
	Grouped  string `db:"grouped"`
	Computed int    `db:"computed"`
}
type catalogInternal struct{ model.BaseModel }

func TestModelCatalogExclusionsAndGroups(t *testing.T) {
	if err := orm.Register[catalogRecord](orm.WithTableName("mcp_catalog_record"), orm.WithExcludeFields("secret"),
		orm.WithReadOnlyFields("computed"), orm.WithFieldGroups(map[string][]string{"grouped": {"finance"}})); err != nil {
		t.Fatal(err)
	}
	if err := orm.Register[catalogInternal](orm.WithTableName("mcp_catalog_internal"), orm.WithExcluded()); err != nil {
		t.Fatal(err)
	}
	for _, grouped := range []bool{false, true} {
		ctx := context.Background()
		if grouped {
			ctx = access.WithGroups(ctx, []string{"finance"})
		}
		found := false
		for _, m := range ormserver.ModelCatalog(ctx) {
			if m.Name == "mcp_catalog_internal" {
				t.Fatal("internal table exposed")
			}
			if m.Name != "mcp_catalog_record" {
				continue
			}
			found = true
			columns := map[string]ormserver.APIField{}
			for _, field := range m.Fields {
				columns[field.Column] = field
			}
			if _, ok := columns["secret"]; ok {
				t.Fatal("excluded field exposed")
			}
			if _, ok := columns["grouped"]; ok != grouped {
				t.Fatalf("grouped field: visible=%v expected=%v", ok, grouped)
			}
			if !columns["computed"].ReadOnly {
				t.Fatal("computed field is writable")
			}
		}
		if !found {
			t.Fatal("model missing")
		}
	}
}
