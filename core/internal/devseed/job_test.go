package devseed_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/devseed"
	"core/internal/notify"
	"core/internal/testdb"
	_ "core/modules/notify"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func TestHandler_SeedRunsInBackground(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "graphfield", "contact", "crm", "warehouse",
		"sale", "propertymanagement", "event", "notify")
	ctx := context.Background()
	tenant, user := uuid.New(), uuid.New()
	t.Cleanup(func() {
		for _, table := range append(seededTables, "notification") {
			_, _ = app.DB.Exec(ctx, "DELETE FROM "+table+" WHERE tenant_id = $1", tenant)
		}
	})
	if _, err := app.DB.Exec(ctx, "INSERT INTO company (tenant_id, name, currency, is_default) VALUES ($1, 'Home', 'EUR', true)", tenant); err != nil {
		t.Fatal(err)
	}
	svc := notify.NewService(notify.NewRepository(app.DB), nil)
	h := devseed.NewHandlerN(app.DB, nil, "development", svc, 20) // 20 rows per table: fast
	var indexed atomic.Int32
	h.SetIndexer(func(context.Context, *orm.DB) ([]string, error) { indexed.Add(1); return nil, nil })

	post := func(body string) *httptest.ResponseRecorder {
		e := echo.New()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/dev_seed", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: user, TenantID: tenant}))
		rec := httptest.NewRecorder()
		if err := h.Seed(e.NewContext(req, rec)); err != nil {
			e.HTTPErrorHandler(e.NewContext(req, rec), err)
		}
		return rec
	}

	if rec := post(`{"groups":["nope"]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown group: code = %d, want 400 before anything starts", rec.Code)
	}
	rec := post(`{"groups":["contacts"]}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d %s", rec.Code, rec.Body)
	}
	var body struct {
		NotificationID uuid.UUID `json:"notification_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)

	if rec := post(`{"groups":["crm"]}`); rec.Code != http.StatusConflict {
		t.Errorf("second seed while running: code = %d, want 409", rec.Code)
	}

	var status string
	for deadline := time.Now().Add(2 * time.Minute); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		_ = app.DB.QueryRow(ctx, `SELECT status FROM notification WHERE id = $1`, body.NotificationID).Scan(&status)
		if status != "running" {
			break
		}
	}
	if status != "done" {
		t.Fatalf("status = %q, want done", status)
	}
	if n := indexed.Load(); n != 1 {
		t.Errorf("search indexer called %d times after a successful seed, want 1", n)
	}
	var data string
	_ = app.DB.QueryRow(ctx, `SELECT data FROM notification WHERE id = $1`, body.NotificationID).Scan(&data)
	if !strings.Contains(data, `"entity":"contact"`) {
		t.Errorf("results data = %s", data)
	}
	var personal int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM notification WHERE user_id = $1 AND link = '/settings/developer'`, user).Scan(&personal)
	if personal != 1 {
		t.Errorf("initiator personal notifications = %d, want 1", personal)
	}
}

func TestRunJob_FailureFinishesFailed(t *testing.T) {
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "notify")
	tenant, user := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = app.DB.Exec(context.Background(), `DELETE FROM notification WHERE tenant_id = $1`, tenant)
	})
	svc := notify.NewService(notify.NewRepository(app.DB), nil)

	tests := []struct {
		name string
		seed devseed.SeedFunc
		body string
	}{
		{"error", func(_ context.Context, p devseed.Progress) ([]devseed.Result, error) {
			p(50, "halfway")
			return nil, errors.New("boom")
		}, "boom"},
		{"panic", func(context.Context, devseed.Progress) ([]devseed.Result, error) {
			panic("kaboom")
		}, "seed panicked: kaboom"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			id, err := devseed.RunJob(context.Background(), svc, tenant, user, tc.seed, true)
			if err != nil {
				t.Fatal(err)
			}
			var status, body string
			_ = app.DB.QueryRow(context.Background(), `SELECT status, body FROM notification WHERE id = $1`, id).Scan(&status, &body)
			if status != "failed" || body != tc.body {
				t.Errorf("status/body = %q/%q", status, body)
			}
		})
	}
	var titles int
	_ = app.DB.QueryRow(context.Background(), `SELECT count(*) FROM notification WHERE user_id = $1 AND title = 'Demo data seeding failed'`, user).Scan(&titles)
	if titles != 2 {
		t.Errorf("personal failure notifications = %d, want 2", titles)
	}
}
