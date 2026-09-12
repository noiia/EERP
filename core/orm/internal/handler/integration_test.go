//go:build integration

package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"core/orm"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	"core/orm/model"
	ormserver "core/orm/server"

	"github.com/labstack/echo/v4"
)

// TestItem is the integration test fixture table.
// The table must exist in the TEST_DSN database.
type TestItem struct {
	model.BaseModel
	Name string `db:"name"`
}

func setupIntegration(t *testing.T) (*orm.App, *echo.Echo) {
	t.Helper()
	dsn := os.Getenv("TEST_DSN")
	if dsn == "" {
		t.Skip("TEST_DSN not set")
	}

	app, err := orm.New(orm.Config{DSN: dsn}, nil)
	if err != nil {
		t.Fatalf("orm.New: %v", err)
	}

	// Ensure table exists.
	ctx := context.Background()
	_, err = app.DB.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS test_items (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name       TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			deleted_at TIMESTAMPTZ
		)`)
	if err != nil {
		t.Fatalf("create table: %v", err)
	}

	// Clean state before each test.
	t.Cleanup(func() {
		app.DB.Exec(ctx, "DELETE FROM test_items") //nolint:errcheck
		app.Close()                                 //nolint:errcheck
	})

	registry.Reset()
	_ = registry.Register[TestItem]()
	meta, _ := registry.Get("test_item")

	repo := crud.NewRepository(app.DB, meta)
	svc := crud.NewService(repo, meta)
	h := handler.NewGenericHandlerFromSvc(svc, meta)

	e := ormserver.NewEcho(app)
	ormserver.MountHandler(e, h)

	return app, e
}

func do(e *echo.Echo, method, path, body string) *httptest.ResponseRecorder {
	var bodyBytes []byte
	if body != "" {
		bodyBytes = []byte(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
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
		t.Fatalf("GET list expected 200, got %d", rec.Code)
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
