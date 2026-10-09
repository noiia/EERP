package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/testdb"
	"core/orm"
	"core/orm/access"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	"core/orm/model"
	ormserver "core/orm/server"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Test-only tables (dropped by the tests' cleanup): places carry a point,
// zones a shape.
type GeoPlace struct {
	model.BaseModel
	Name  string        `db:"name"`
	Where *orm.GeoPoint `db:"geo_location,index=gist"`
}

type GeoZone struct {
	model.BaseModel
	Name string        `db:"name"`
	Area *orm.GeoShape `db:"area,index=gist"`
}

func setupGeo(t *testing.T) (*orm.App, *echo.Echo) {
	t.Helper()
	app := testdb.Open(t)
	_ = registry.Register[GeoPlace](registry.WithTableName("geo_places"))
	_ = registry.Register[GeoZone](registry.WithTableName("geo_zones"))
	testdb.Migrate(t, app, "geo_places", "geo_zones")
	t.Cleanup(func() {
		_, _ = app.DB.Exec(context.Background(), `DROP TABLE IF EXISTS geo_places, geo_zones`)
	})
	handlers := map[string]*handler.GenericHandler{}
	for _, table := range []string{"geo_places", "geo_zones"} {
		meta, _ := registry.Get(table)
		handlers[table] = handler.NewGenericHandlerFromSvc(crud.NewService(crud.NewRepository(app.DB, meta), meta), meta)
	}
	srv := ormserver.New(app, ormserver.Config{})
	srv.RegisterRoutes(handlers, nil)
	return app, srv.Echo()
}

// doAs sends a request as tenant; readable lists the tables the caller may
// read (the permission middleware's read check), nil = none.
func doAs(e *echo.Echo, tenant uuid.UUID, readable []string, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	ctx := access.WithTenant(req.Context(), tenant)
	if readable != nil {
		ctx = access.WithReadCheck(ctx, func(table string) bool {
			for _, r := range readable {
				if r == table {
					return true
				}
			}
			return false
		})
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func decodeObj(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode %d %s: %v", rec.Code, rec.Body.String(), err)
	}
	return m
}

func TestGeo_CRUDRoundTrip(t *testing.T) {
	_, e := setupGeo(t)
	tenant := uuid.New()

	rec := doAs(e, tenant, nil, http.MethodPost, "/api/v1/geo_places",
		`{"name":"Paris","geo_location":{"type":"Point","coordinates":[2.35,48.85]}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	created := decodeObj(t, rec)
	id := created["id"].(string)
	loc, _ := json.Marshal(created["geo_location"])
	if string(loc) != `{"coordinates":[2.35,48.85],"type":"Point"}` {
		t.Errorf("created geo_location = %s", loc)
	}

	got := decodeObj(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places/"+id, ""))
	if loc, _ := json.Marshal(got["geo_location"]); string(loc) != `{"coordinates":[2.35,48.85],"type":"Point"}` {
		t.Errorf("read geo_location = %s", loc)
	}

	// List responses convert too.
	list := decodeObj(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places", ""))
	rows, _ := list["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("list = %v", list)
	}
	if loc, _ := json.Marshal(rows[0].(map[string]any)["geo_location"]); string(loc) != `{"coordinates":[2.35,48.85],"type":"Point"}` {
		t.Errorf("list geo_location = %s", loc)
	}

	// Clearing stores NULL (Review Focus 3).
	rec = doAs(e, tenant, nil, http.MethodPut, "/api/v1/geo_places/"+id, `{"name":"Paris","geo_location":null}`)
	if rec.Code != http.StatusOK || decodeObj(t, rec)["geo_location"] != nil {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	}

	// A zone round-trips as its GeoJSON polygon.
	rec = doAs(e, tenant, nil, http.MethodPost, "/api/v1/geo_zones",
		`{"name":"Z","area":{"type":"Polygon","coordinates":[[[2,48],[3,48],[3,49],[2,49],[2,48]]]}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("zone: %d %s", rec.Code, rec.Body.String())
	}
	if area := decodeObj(t, rec)["area"].(map[string]any); area["type"] != "Polygon" {
		t.Errorf("area = %v", area)
	}
}

func TestGeo_InvalidGeometryIs422(t *testing.T) {
	_, e := setupGeo(t)
	for _, body := range []string{
		`{"name":"x","geo_location":{"type":"Point","coordinates":[200,0]}}`,
		`{"name":"x","geo_location":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}}`,
		`{"name":"x","geo_location":"POINT(1 2)"}`,
	} {
		rec := doAs(e, uuid.New(), nil, http.MethodPost, "/api/v1/geo_places", body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
			continue
		}
		errObj := decodeObj(t, rec)["error"].(map[string]any)
		if errObj["code"] != "VALIDATION_ERROR" {
			t.Errorf("%s: %v", body, errObj)
		}
		if f, _ := json.Marshal(errObj["fields"]); string(f) != `["geo_location"]` {
			t.Errorf("%s: fields = %s", body, f)
		}
	}
}

func TestGeo_InvalidUpdateIs422AndWritesNothing(t *testing.T) {
	_, e := setupGeo(t)
	tenant := uuid.New()
	rec := doAs(e, tenant, nil, http.MethodPost, "/api/v1/geo_places",
		`{"name":"Paris","geo_location":{"type":"Point","coordinates":[2.35,48.85]}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	id := decodeObj(t, rec)["id"].(string)

	rec = doAs(e, tenant, nil, http.MethodPut, "/api/v1/geo_places/"+id,
		`{"name":"Lyon","geo_location":{"type":"Point","coordinates":[200,0]}}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update: %d %s", rec.Code, rec.Body.String())
	}
	errObj := decodeObj(t, rec)["error"].(map[string]any)
	if f, _ := json.Marshal(errObj["fields"]); errObj["code"] != "VALIDATION_ERROR" || string(f) != `["geo_location"]` {
		t.Errorf("envelope = %v", errObj)
	}

	got := decodeObj(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places/"+id, ""))
	if loc, _ := json.Marshal(got["geo_location"]); string(loc) != `{"coordinates":[2.35,48.85],"type":"Point"}` || got["name"] != "Paris" {
		t.Errorf("record changed: %v", got)
	}
}

func createGeo(t *testing.T, e *echo.Echo, tenant uuid.UUID, path, body string) string {
	t.Helper()
	rec := doAs(e, tenant, nil, http.MethodPost, path, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %s: %d %s", path, rec.Code, rec.Body.String())
	}
	return decodeObj(t, rec)["id"].(string)
}

func names(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var body struct{ Data []map[string]any }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	out := []string{}
	for _, row := range body.Data {
		out = append(out, row["name"].(string))
	}
	return out
}

func TestGeo_NearWithinCovers(t *testing.T) {
	_, e := setupGeo(t)
	tenant := uuid.New()
	pt := func(lon, lat string) string { return `{"type":"Point","coordinates":[` + lon + `,` + lat + `]}` }
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Paris","geo_location":`+pt("2.35", "48.85")+`}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Lyon","geo_location":`+pt("4.83", "45.76")+`}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Versailles","geo_location":`+pt("2.13", "48.80")+`}`)
	createGeo(t, e, tenant, "/api/v1/geo_places", `{"name":"Nowhere"}`) // no location (Review Focus 2)
	createGeo(t, e, tenant, "/api/v1/geo_zones", `{"name":"IDF","area":{"type":"Polygon","coordinates":[[[1.4,48.1],[3.6,48.1],[3.6,49.3],[1.4,49.3],[1.4,48.1]]]}}`)

	// Nearest to Paris first; the unlocated row last with a null distance.
	rec := doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places?near[geo_location]=2.35,48.85", "")
	if got := names(t, rec); len(got) != 4 || got[0] != "Paris" || got[1] != "Versailles" || got[2] != "Lyon" || got[3] != "Nowhere" {
		t.Errorf("near order = %v", got)
	}
	var body struct{ Data []map[string]any }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if d, _ := body.Data[1]["_distance_m"].(float64); d < 16000 || d > 18000 {
		t.Errorf("Paris→Versailles = %v m, want ~17 km", body.Data[1]["_distance_m"])
	}
	if body.Data[3]["_distance_m"] != nil {
		t.Errorf("unlocated distance = %v, want null", body.Data[3]["_distance_m"])
	}
	if _, ok := decodeObj(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places", ""))["data"].([]any)[0].(map[string]any)["_distance_m"]; ok {
		t.Error("_distance_m present without near")
	}

	// 50 km radius around Paris.
	if got := names(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_places?within[geo_location]=2.35,48.85,50000&near[geo_location]=2.35,48.85", "")); len(got) != 2 {
		t.Errorf("within = %v, want Paris+Versailles", got)
	}
	// Which zone covers Paris / Lyon.
	if got := names(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_zones?covers[area]=2.35,48.85", "")); len(got) != 1 {
		t.Errorf("covers Paris = %v", got)
	}
	if got := names(t, doAs(e, tenant, nil, http.MethodGet, "/api/v1/geo_zones?covers[area]=4.83,45.76", "")); len(got) != 0 {
		t.Errorf("covers Lyon = %v", got)
	}

	for _, bad := range []string{
		"/api/v1/geo_places?near[geo_location]=200,0",
		"/api/v1/geo_places?near[name]=2,48",
		"/api/v1/geo_places?within[geo_location]=2,48",
		"/api/v1/geo_places?within[geo_location]=2,48,-5",
		"/api/v1/geo_zones?covers[geo_location]=2,48",
		"/api/v1/geo_places?covers[geo_location]=2,48",
	} {
		if rec := doAs(e, tenant, nil, http.MethodGet, bad, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", bad, rec.Code)
		}
	}
}
