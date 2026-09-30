package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func call(t *testing.T, h echo.HandlerFunc, method, path, route string, tenant uuid.UUID) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	e.Add(method, route, h)
	req := httptest.NewRequest(method, path, nil)
	req = req.WithContext(access.WithTenant(req.Context(), tenant))
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestHandler(t *testing.T) {
	app, tenant := setup(t)
	ctx := context.Background()
	h := NewHandler(app.DB)
	if err := Enqueue(ctx, app.DB, Message{TenantID: tenant, To: "a@x.io", Subject: "s", Text: "t"}); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	_ = app.DB.QueryRow(ctx, `SELECT id FROM mail_outbox WHERE tenant_id = $1`, tenant).Scan(&id)
	_, _ = app.DB.Exec(ctx, `UPDATE mail_outbox SET status = 'failed', attempts = 5 WHERE id = $1`, id)

	t.Run("list filters by status, tenant-pinned", func(t *testing.T) {
		rec := call(t, h.List, http.MethodGet, "/mail_outbox?status=failed", "/mail_outbox", tenant)
		var body struct {
			Data  []map[string]any `json:"data"`
			Total int              `json:"total"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusOK || body.Total != 1 || body.Data[0]["to_address"] != "a@x.io" {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		other := call(t, h.List, http.MethodGet, "/mail_outbox", "/mail_outbox", uuid.New())
		body.Total = -1
		_ = json.Unmarshal(other.Body.Bytes(), &body)
		if other.Code != http.StatusOK || body.Total != 0 {
			t.Errorf("other tenant sees %d %s", other.Code, other.Body)
		}
	})

	t.Run("retry of another tenant's row is 404", func(t *testing.T) {
		rec := call(t, h.Retry, http.MethodPost, "/mail_outbox/"+id.String()+"/retry", "/mail_outbox/:id/retry", uuid.New())
		if rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("retry re-queues a failed row", func(t *testing.T) {
		rec := call(t, h.Retry, http.MethodPost, "/mail_outbox/"+id.String()+"/retry", "/mail_outbox/:id/retry", tenant)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
		var status string
		var attempts int
		_ = app.DB.QueryRow(ctx, `SELECT status, attempts FROM mail_outbox WHERE id = $1`, id).Scan(&status, &attempts)
		if status != StatusPending || attempts != 0 {
			t.Errorf("status=%s attempts=%d", status, attempts)
		}
	})
}
