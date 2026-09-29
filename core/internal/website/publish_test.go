package website

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"core/orm"

	"github.com/google/uuid"
)

type memStore map[string]string

func (m memStore) Get(_ context.Context, _, _ uuid.UUID, key string) (string, bool, error) {
	v, ok := m[key]
	return v, ok, nil
}
func (m memStore) Set(_ context.Context, _, _ uuid.UUID, key, value string) error {
	m[key] = value
	return nil
}

type pubThing struct {
	ID        uuid.UUID `db:"id,pk"`
	Name      string    `db:"name"`
	Cost      float64   `db:"cost"`
	Published bool      `db:"published"`
}

func TestPublisher_Resolve(t *testing.T) {
	if err := orm.Register[pubThing](orm.WithPublicFields("name", "cost")); err != nil {
		t.Fatal(err)
	}
	sel := func(s Selection) string { b, _ := json.Marshal(s); return string(b) }
	tests := []struct {
		name      string
		stored    string
		wantOK    bool
		wantCols  []string
		wantEqual map[string]string
	}{
		{"nothing published", "", false, nil, nil},
		{"empty field list", sel(Selection{Filter: map[string]string{"published": "true"}}), false, nil, nil},
		{"subset + forced filter", sel(Selection{Fields: []string{"name"}, Filter: map[string]string{"published": "true"}}),
			true, []string{"name", "id"}, map[string]string{"published": "true"}},
		// Review Focus #5: a field the module no longer declares is dropped, never exposed.
		{"undeclared field dropped", sel(Selection{Fields: []string{"name", "published"}}), true, []string{"name", "id"}, nil},
		{"corrupt JSON degrades to unpublished", "{", false, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := memStore{}
			if tt.stored != "" {
				store[PublicKey("pub_thing")] = tt.stored
			}
			scope, ok, err := NewPublisher(store, uuid.New()).Resolve(context.Background(), "pub_thing")
			if err != nil || ok != tt.wantOK {
				t.Fatalf("ok=%v err=%v, want ok=%v", ok, err, tt.wantOK)
			}
			if ok && (!slices.Equal(scope.Columns, tt.wantCols) || len(scope.Equals) != len(tt.wantEqual)) {
				t.Errorf("scope = %+v, want cols %v equals %v", scope, tt.wantCols, tt.wantEqual)
			}
		})
	}
	t.Run("undeclared table", func(t *testing.T) {
		if _, ok, _ := NewPublisher(memStore{}, uuid.New()).Resolve(context.Background(), "nope"); ok {
			t.Error("undeclared table resolved as published")
		}
	})
}

func TestValidateSelection(t *testing.T) {
	declared := []string{"name", "cost"}
	tests := []struct {
		name    string
		sel     Selection
		wantErr bool
	}{
		{"valid", Selection{Fields: []string{"name"}, Filter: map[string]string{"published": "true"}}, false},
		{"field not declared", Selection{Fields: []string{"published"}}, true},
		{"filter column unknown", Selection{Fields: []string{"name"}, Filter: map[string]string{"nope": "1"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateSelection("pub_thing", declared, tt.sel); (err != nil) != tt.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
