package settings

import (
	"encoding/json"
	"net/http"
	"testing"

	"core/internal/auth"

	"github.com/google/uuid"
)

func TestRegisterGraphPreset(t *testing.T) {
	type tile struct {
		ID   string         `json:"id"`
		W    int            `json:"w"`
		H    int            `json:"h"`
		Type string         `json:"type"`
		Cfg  map[string]any `json:"config"`
	}
	tests := []struct {
		name    string
		entity  string
		tiles   any
		wantErr bool
	}{
		{"valid", "preset_ok", []tile{{ID: "a", W: 2, H: 2, Type: "stat"}}, false},
		{"bad entity", "../x", []tile{{ID: "a", W: 2, H: 2, Type: "stat"}}, true},
		{"not a tile array", "preset_bad", map[string]int{"x": 1}, true},
		{"fails the layout checks", "preset_bad", []tile{{ID: "a", W: 0, H: 2, Type: "stat"}}, true},
		{"unmarshalable", "preset_bad", func() {}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := RegisterGraphPreset(tt.entity, tt.tiles)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
	if got := graphPreset("preset_bad"); got != nil {
		t.Errorf("a refused preset was stored: %v", got)
	}
}

// The preset rides the GET beside the saved tiles, so an entity whose layout
// was already set (and so never seeded) can still pull the defaults in.
func TestGetGraphLayoutSettings_Defaults(t *testing.T) {
	if err := RegisterGraphPreset("preset_entity", []map[string]any{{"id": "d1", "x": 0, "y": 0, "w": 4, "h": 4, "type": "pie", "config": map[string]any{}}}); err != nil {
		t.Fatal(err)
	}
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	for _, tt := range []struct {
		entity    string
		stored    string
		wantTiles int
		wantDefs  int
	}{
		{"preset_entity", `{"tiles":[{"id":"mine","x":0,"y":0,"w":2,"h":2,"type":"stat","config":{}}]}`, 1, 1},
		{"preset_entity", "", 0, 1},
		{"no_preset", "", 0, 0},
	} {
		store := &stubStore{values: map[string]string{}}
		if tt.stored != "" {
			store.values[ViewGraphKey(tt.entity)] = tt.stored
		}
		h := NewHandler(&stubUsers{}, store, &stubCompanies{}, "development")
		rec := serveWithParam(t, h.GetGraphLayoutSettings, http.MethodGet, "/settings/views/"+tt.entity+"/graph", "", identity, "entity", tt.entity)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", tt.entity, rec.Code)
		}
		var resp struct {
			Tiles    []map[string]any `json:"tiles"`
			Defaults []map[string]any `json:"defaults"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if len(resp.Tiles) != tt.wantTiles || len(resp.Defaults) != tt.wantDefs {
			t.Errorf("%s stored=%q: %d tiles, %d defaults; want %d, %d", tt.entity, tt.stored, len(resp.Tiles), len(resp.Defaults), tt.wantTiles, tt.wantDefs)
		}
	}
}

// A client echoing `defaults` back in a PUT must not store them.
func TestPutGraphLayoutSettings_IgnoresDefaults(t *testing.T) {
	identity := auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}
	store := &stubStore{}
	h := NewHandler(&stubUsers{}, store, &stubCompanies{}, "development")
	body := `{"tiles":[],"defaults":[{"id":"d1","x":0,"y":0,"w":4,"h":4,"type":"pie","config":{}}]}`
	rec := serveWithParam(t, h.PutGraphLayoutSettings, http.MethodPut, "/settings/views/crm/graph", body, identity, "entity", "crm")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if store.gotValue != `{"tiles":[]}` {
		t.Errorf("stored %q", store.gotValue)
	}
}
