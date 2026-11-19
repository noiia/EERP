package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"core/internal/testdb"
	"core/orm/access"
	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	ormserver "core/orm/server"

	"github.com/google/uuid"
)

// HardItem has no deleted_at: its DELETE removes the row for good.
type HardItem struct {
	ID        uuid.UUID `db:"id,pk"`
	TenantID  uuid.UUID `db:"tenant_id,index"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
	Name      string    `db:"name"`
}

// A table without soft-delete is hard-deleted by the generic DELETE: the
// row is gone, a second delete is a 404, and another tenant can't touch it.
func TestIntegration_HardDelete(t *testing.T) {
	app := testdb.Open(t)
	ctx := context.Background()
	_ = registry.Register[HardItem](registry.WithTableName("test_hard_items"))
	testdb.Migrate(t, app, "test_hard_items")
	t.Cleanup(func() { _, _ = app.DB.Exec(ctx, "DELETE FROM test_hard_items") })
	meta, _ := registry.Get("test_hard_items")
	h := handler.NewGenericHandlerFromSvc(crud.NewService(crud.NewRepository(app.DB, meta), meta), meta)
	srv := ormserver.New(app, ormserver.Config{})
	srv.RegisterRoutes(map[string]*handler.GenericHandler{"h": h}, nil)
	e := srv.Echo()

	as := func(tenant uuid.UUID, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(access.WithTenant(req.Context(), tenant))
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}

	rec := as(testTenant, http.MethodPost, "/api/v1/test_hard_items", `{"name":"gone soon"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST = %d %s", rec.Code, rec.Body)
	}
	var created map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	id := fmt.Sprintf("%v", created["id"])

	if rec := as(uuid.New(), http.MethodDelete, "/api/v1/test_hard_items/"+id, ""); rec.Code != http.StatusNotFound {
		t.Errorf("DELETE from another tenant = %d, want 404", rec.Code)
	}
	if rec := as(testTenant, http.MethodDelete, "/api/v1/test_hard_items/"+id, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d %s", rec.Code, rec.Body)
	}
	var left int
	if err := app.DB.QueryRow(ctx, `SELECT count(*) FROM test_hard_items WHERE id = $1`, id).Scan(&left); err != nil || left != 0 {
		t.Errorf("row still there (%d, %v): not a hard delete", left, err)
	}
	if rec := as(testTenant, http.MethodDelete, "/api/v1/test_hard_items/"+id, ""); rec.Code != http.StatusNotFound {
		t.Errorf("second DELETE = %d, want 404", rec.Code)
	}
}
