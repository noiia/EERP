package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

// TestItem is the integration test fixture table.
// The table is created from the registered model (testdb.Migrate).
type TestItem struct {
	model.BaseModel
	Name string `db:"name"`
}

func setupIntegration(t *testing.T) (*orm.App, *echo.Echo) {
	t.Helper()
	app := testdb.Open(t)

	ctx := context.Background()
	// Clean state before each test.
	t.Cleanup(func() {
		app.DB.Exec(ctx, "DELETE FROM test_items") //nolint:errcheck
	})

	_ = registry.Register[TestItem](registry.WithTableName("test_items"))
	testdb.Migrate(t, app, "test_items") // the real columns, BaseModel's tenant_id included
	meta, _ := registry.Get("test_items")

	repo := crud.NewRepository(app.DB, meta)
	svc := crud.NewService(repo, meta)
	h := handler.NewGenericHandlerFromSvc(svc, meta)

	srv := ormserver.New(app, ormserver.Config{})
	srv.RegisterRoutes(map[string]*handler.GenericHandler{"h": h}, nil)
	e := srv.Echo()

	return app, e
}

// testTenant is the tenant every test request acts as.
var testTenant = uuid.MustParse("00000000-0000-0000-0000-00000000cafe")

func do(e *echo.Echo, method, path, body string) *httptest.ResponseRecorder {
	var bodyBytes []byte
	if body != "" {
		bodyBytes = []byte(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	// Generic CRUD refuses a request with no tenant scope (JWTMiddleware sets it
	// in production); every test request acts as one fixed tenant.
	req = req.WithContext(access.WithTenant(req.Context(), testTenant))
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestIntegration_CRUD_SoftDelete(t *testing.T) {
	_, e := setupIntegration(t)

	// POST → 201
	rec := do(e, http.MethodPost, "/api/v1/test_items", `{"name":"alpha"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST expected 201, got %d: %s", rec.Code, rec.Body)
	}

	var created map[string]any
	json.Unmarshal(rec.Body.Bytes(), &created) //nolint:errcheck
	id := fmt.Sprintf("%v", created["id"])

	// GET list → record present
	rec = do(e, http.MethodGet, "/api/v1/test_items", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET list expected 200, got %d: %s", rec.Code, rec.Body)
	}
	var list struct {
		Total int              `json:"total"`
		Data  []map[string]any `json:"data"`
	}
	json.Unmarshal(rec.Body.Bytes(), &list) //nolint:errcheck
	if list.Total < 1 {
		t.Error("expected at least 1 record in list")
	}

	// GET by id → 200
	rec = do(e, http.MethodGet, "/api/v1/test_items/"+id, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET by id expected 200, got %d", rec.Code)
	}

	// PUT → 200, fields updated
	rec = do(e, http.MethodPut, "/api/v1/test_items/"+id, `{"name":"beta"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT expected 200, got %d: %s", rec.Code, rec.Body)
	}
	var updated map[string]any
	json.Unmarshal(rec.Body.Bytes(), &updated) //nolint:errcheck
	if updated["name"] != "beta" {
		t.Errorf("updated name = %v, want beta", updated["name"])
	}

	// DELETE → 204 (soft delete)
	rec = do(e, http.MethodDelete, "/api/v1/test_items/"+id, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE expected 204, got %d", rec.Code)
	}

	// GET list → record absent (soft-deleted)
	rec = do(e, http.MethodGet, "/api/v1/test_items", "")
	json.Unmarshal(rec.Body.Bytes(), &list) //nolint:errcheck
	for _, row := range list.Data {
		if fmt.Sprintf("%v", row["id"]) == id {
			t.Error("soft-deleted record should not appear in list")
		}
	}

	// POST restore → 200
	rec = do(e, http.MethodPost, "/api/v1/test_items/"+id+"/restore", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("restore expected 200, got %d: %s", rec.Code, rec.Body)
	}

	// GET list → record back
	rec = do(e, http.MethodGet, "/api/v1/test_items", "")
	json.Unmarshal(rec.Body.Bytes(), &list) //nolint:errcheck
	found := false
	for _, row := range list.Data {
		if fmt.Sprintf("%v", row["id"]) == id {
			found = true
		}
	}
	if !found {
		t.Error("restored record should appear in list")
	}
}
