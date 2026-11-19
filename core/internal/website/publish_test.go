package website

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
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
	if err := orm.Register[pubThing](orm.WithPublicFields("name", "cost", "picture")); err != nil {
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
		// "picture" is a non-column anchor field: alone it would publish bare ids.
		{"only non-column fields is unpublished", sel(Selection{Fields: []string{"picture"}}), false, nil, nil},
		{"non-column field kept beside a column", sel(Selection{Fields: []string{"name", "picture"}}), true, []string{"name", "picture", "id"}, nil},
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
	declared := []string{"name", "cost", "picture"}
	tests := []struct {
		name    string
		sel     Selection
		wantErr bool
	}{
		{"valid", Selection{Fields: []string{"name"}, Filter: map[string]string{"published": "true"}}, false},
		{"field not declared", Selection{Fields: []string{"published"}}, true},
		{"only non-column fields", Selection{Fields: []string{"picture"}}, true},
		{"empty field list unpublishes", Selection{}, false},
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

// The editor reads fields as string[]: an unpublished table must serialize [] not null.
func TestGetPublished_UnpublishedFieldsIsEmptyArray(t *testing.T) {
	if err := orm.Register[pubThing](orm.WithPublicFields("name", "cost", "picture")); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{TenantID: uuid.New()}))
	rec := httptest.NewRecorder()
	if err := NewPublisher(memStore{}, uuid.New()).GetPublished(echo.New().NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	if body := rec.Body.String(); strings.Contains(body, `"fields":null`) || !strings.Contains(body, `"fields":[]`) {
		t.Errorf("body = %s, want \"fields\":[] for the unpublished table", body)
	}
	// pub_thing: "picture" is an anchor (no column), "published" a bool but not declared.
	if body := rec.Body.String(); !strings.Contains(body, `"pictures":["picture"]`) {
		t.Errorf("body = %s, want pictures [picture]", body)
	}
}
