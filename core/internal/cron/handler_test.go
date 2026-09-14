package cron

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

type stubHistoryStore struct {
	byID map[uuid.UUID]CronHistory
}

func (s *stubHistoryStore) FindInTenant(_ context.Context, tenantID, id uuid.UUID) (CronHistory, error) {
	h, ok := s.byID[id]
	if !ok || h.TenantID != tenantID {
		return CronHistory{}, orm.ErrNotFound
	}
	return h, nil
}

func newTestContext(method, path string) (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	return e.NewContext(req, rec), rec
}

func withIdentity(c echo.Context, tenantID uuid.UUID) echo.Context {
	ctx := auth.SetIdentity(c.Request().Context(), auth.Identity{TenantID: tenantID, UserID: uuid.New()})
	c.SetRequest(c.Request().WithContext(ctx))
	return c
}

func TestDownloadLog_StreamsExistingFile(t *testing.T) {
	dir := t.TempDir()
	tenant := uuid.New()
	histID := uuid.New()
	path := LogPath(dir, tenant, uuid.New(), uuid.New())
	if err := WriteLog(path, "hello log\n"); err != nil {
		t.Fatalf("WriteLog: %v", err)
	}

	store := &stubHistoryStore{byID: map[uuid.UUID]CronHistory{
		histID: {TenantID: tenant, LogsFilepath: path},
	}}
	h := newHandlerWith(store)

	c, rec := newTestContext(http.MethodGet, "/api/v1/cron_history/"+histID.String()+"/log")
	c = withIdentity(c, tenant)
	c.SetParamNames("id")
	c.SetParamValues(histID.String())

	if err := h.DownloadLog(c); err != nil {
		t.Fatalf("DownloadLog: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != "hello log\n" {
		t.Fatalf("body = %q, want %q", rec.Body.String(), "hello log\n")
	}
}

func TestDownloadLog_NotFoundForOtherTenant(t *testing.T) {
	tenant := uuid.New()
	otherTenant := uuid.New()
	histID := uuid.New()

	store := &stubHistoryStore{byID: map[uuid.UUID]CronHistory{
		histID: {TenantID: otherTenant, LogsFilepath: "/does/not/matter"},
	}}
	h := newHandlerWith(store)

	c, rec := newTestContext(http.MethodGet, "/api/v1/cron_history/"+histID.String()+"/log")
	c = withIdentity(c, tenant)
	c.SetParamNames("id")
	c.SetParamValues(histID.String())

	if err := h.DownloadLog(c); err != nil {
		t.Fatalf("DownloadLog: %v", err)
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
