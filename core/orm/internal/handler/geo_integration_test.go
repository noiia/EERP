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
