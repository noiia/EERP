package formtarget

import "testing"

func init() {
	RegisterFormTarget("contact", "name", "email", "phone")
	RegisterFormTarget("crm", "name", "contact_id", "status")
	RegisterFormTarget("addr", "home_number", "home_complement", "home_street", "home_zip_code", "home_city", "home_state", "home_country", "note")
}

func TestValidateFormConfig(t *testing.T) {
	ok := func() FormConfig {
		return FormConfig{
			Targets: []FormTargetSpec{{Table: "contact"}, {Table: "crm", Links: map[string]int{"contact_id": 0}}},
			Fields: []FormField{
				{ID: "a", Label: "Name", Type: "text", Column: "name", Target: 0},
				{ID: "b", Label: "Topic", Type: "text", Column: "name", Target: 1},
			},
		}
	}
	tests := []struct {
		name   string
		mutate func(*FormConfig)
		wantOK bool
	}{
		{"valid", func(*FormConfig) {}, true},
		{"no target", func(c *FormConfig) { c.Targets = nil; c.Fields = nil }, false},
		{"unregistered table", func(c *FormConfig) { c.Targets[0].Table = "users" }, false},
		{"unregistered column", func(c *FormConfig) { c.Fields[0].Column = "password_hash" }, false},
		{"unregistered fixed column", func(c *FormConfig) { c.Targets[0].Fixed = map[string]string{"role": "x"} }, false},
		{"unregistered link column", func(c *FormConfig) { c.Targets[1].Links = map[string]int{"owner": 0} }, false},
		{"forward link", func(c *FormConfig) { c.Targets[1].Links = map[string]int{"contact_id": 1} }, false},
		{"duplicate id", func(c *FormConfig) { c.Fields[1].ID = "a" }, false},
		{"select without options", func(c *FormConfig) { c.Fields[0].Type = "select" }, false},
		{"select with options", func(c *FormConfig) { c.Fields[0].Type = "select"; c.Fields[0].Options = []string{"x"} }, true},
		{"unknown type", func(c *FormConfig) { c.Fields[0].Type = "script" }, false},
		{"target index out of range", func(c *FormConfig) { c.Fields[0].Target = 5 }, false},
		{"address prefix", func(c *FormConfig) { c.Fields[0].Type = "address"; c.Fields[0].Column = "address" }, false},
		// A column is written at most once per target, across fields, links and fixed.
		{"two fields on one column", func(c *FormConfig) { c.Fields[1].Target = 0 }, false},
		{"same column on two targets", func(c *FormConfig) {}, true},
		{"field and fixed on one column", func(c *FormConfig) { c.Targets[0].Fixed = map[string]string{"name": "x"} }, false},
		{"field and link on one column", func(c *FormConfig) {
			c.Fields = append(c.Fields, FormField{ID: "c", Type: "text", Column: "contact_id", Target: 1})
		}, false},
		{"link and fixed on one column", func(c *FormConfig) { c.Targets[1].Fixed = map[string]string{"contact_id": "x"} }, false},
		{"fixed on another column", func(c *FormConfig) { c.Targets[1].Fixed = map[string]string{"status": "lead"} }, true},
		// Ids come only from links/fixed, never from what a visitor types.
		{"visitor field on an _id column", func(c *FormConfig) {
			c.Targets[1].Links = nil
			c.Fields = append(c.Fields, FormField{ID: "c", Type: "text", Column: "contact_id", Target: 1})
		}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := ok()
			tc.mutate(&c)
			err := ValidateFormConfig(c)
			if (err == nil) != tc.wantOK {
				t.Fatalf("err = %v, wantOK %v", err, tc.wantOK)
			}
		})
	}
}

func TestValidateFormConfig_AddressColumnsCountOnce(t *testing.T) {
	base := func() FormConfig {
		return FormConfig{Targets: []FormTargetSpec{{Table: "addr"}},
			Fields: []FormField{{ID: "a", Type: "address", Column: "home"}}}
	}
	if err := ValidateFormConfig(base()); err != nil {
		t.Fatalf("valid address: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*FormConfig)
	}{
		{"address twice", func(c *FormConfig) { c.Fields = append(c.Fields, FormField{ID: "b", Type: "address", Column: "home"}) }},
		{"address and a field on one of its columns", func(c *FormConfig) {
			c.Fields = append(c.Fields, FormField{ID: "b", Type: "text", Column: "home_city"})
		}},
		{"address and a fixed on one of its columns", func(c *FormConfig) { c.Targets[0].Fixed = map[string]string{"home_zip_code": "1"} }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mutate(&c)
			if ValidateFormConfig(c) == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestValidateFormConfig_Limits(t *testing.T) {
	c := FormConfig{}
	for i := 0; i < 11; i++ {
		c.Targets = append(c.Targets, FormTargetSpec{Table: "contact"})
	}
	if ValidateFormConfig(c) == nil {
		t.Fatal("11 targets accepted")
	}
	c = FormConfig{Targets: []FormTargetSpec{{Table: "contact"}}}
	for i := 0; i < 61; i++ {
		c.Fields = append(c.Fields, FormField{ID: string(rune('A'+i/26)) + string(rune('a'+i%26)), Type: "text", Column: "name"})
	}
	if ValidateFormConfig(c) == nil {
		t.Fatal("61 fields accepted")
	}
}

func TestTargets_Sorted(t *testing.T) {
	ts := Targets()
	if len(ts) < 3 || ts[0].Table != "addr" || ts[1].Table != "contact" || ts[2].Table != "crm" || ts[1].Columns[0] != "email" {
		t.Fatalf("unexpected %+v", ts)
	}
}
