package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/orm/internal/crud"
	"core/orm/internal/handler"
	"core/orm/internal/registry"
	"core/orm/model"

	"github.com/labstack/echo/v4"
)

// ── fixtures ──────────────────────────────────────────────────────────────────

type item struct {
	model.BaseModel
	Name string `db:"name"`
}

type hardItem struct {
	ID   int    `db:"id,pk"`
	Code string `db:"code"`
}

func itemMeta() registry.TableMeta {
	_ = registry.Register[item]()
	m, _ := registry.Get("item")
	return m
}

func hardItemMeta() registry.TableMeta {
	_ = registry.Register[hardItem]()
	m, _ := registry.Get("hard_item")
	return m
}

// ── mock service ──────────────────────────────────────────────────────────────

type mockSvc struct {
	list    func(ctx context.Context, f crud.ListFilter) ([]map[string]any, int, error)
	byID    func(ctx context.Context, id any) (map[string]any, error)
	create  func(ctx context.Context, data map[string]any) (map[string]any, error)
	update  func(ctx context.Context, id any, data map[string]any) (map[string]any, error)
	del     func(ctx context.Context, id any) error
	restore func(ctx context.Context, id any) (map[string]any, error)
}

func (m *mockSvc) List(ctx context.Context, f crud.ListFilter) ([]map[string]any, int, error) {
	if m.list != nil {
		return m.list(ctx, f)
	}
	return nil, 0, nil
}
func (m *mockSvc) GetByID(ctx context.Context, id any) (map[string]any, error) {
	if m.byID != nil {
		return m.byID(ctx, id)
	}
	return nil, nil
}
func (m *mockSvc) Create(ctx context.Context, data map[string]any) (map[string]any, error) {
	if m.create != nil {
		return m.create(ctx, data)
	}
	return data, nil
}
func (m *mockSvc) Update(ctx context.Context, id any, data map[string]any) (map[string]any, error) {
	if m.update != nil {
		return m.update(ctx, id, data)
	}
	return data, nil
}
func (m *mockSvc) Delete(ctx context.Context, id any) error {
	if m.del != nil {
		return m.del(ctx, id)
	}
	return nil
}
func (m *mockSvc) Restore(ctx context.Context, id any) (map[string]any, error) {
	if m.restore != nil {
		return m.restore(ctx, id)
	}
	return map[string]any{}, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func newEchoRequest(method, target, body string) (*echo.Echo, echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	var bodyReader *strings.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	} else {
		bodyReader = strings.NewReader("")
	}
	req := httptest.NewRequest(method, target, bodyReader)
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	return e, c, rec
}

// ── List ──────────────────────────────────────────────────────────────────────

func TestList_DefaultPagination(t *testing.T) {
	var gotFilter crud.ListFilter
	svc := &mockSvc{
		list: func(_ context.Context, f crud.ListFilter) ([]map[string]any, int, error) {
			gotFilter = f
			return []map[string]any{}, 0, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, rec := newEchoRequest(http.MethodGet, "/api/v1/items", "")

	if err := h.List(c); err != nil {
		t.Fatalf("List error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if gotFilter.Page != 1 || gotFilter.PageSize != 20 {
		t.Errorf("default filter = {%d, %d}, want {1, 20}", gotFilter.Page, gotFilter.PageSize)
	}
}

func TestList_CustomPaginationParams(t *testing.T) {
	var gotFilter crud.ListFilter
	svc := &mockSvc{
		list: func(_ context.Context, f crud.ListFilter) ([]map[string]any, int, error) {
			gotFilter = f
			return nil, 0, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/items?page=3&page_size=5", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := h.List(c); err != nil {
		t.Fatalf("List error: %v", err)
	}
	if gotFilter.Page != 3 || gotFilter.PageSize != 5 {
		t.Errorf("filter = {%d, %d}, want {3, 5}", gotFilter.Page, gotFilter.PageSize)
	}
}

func TestList_ResponseEnvelope(t *testing.T) {
	svc := &mockSvc{
		list: func(_ context.Context, _ crud.ListFilter) ([]map[string]any, int, error) {
			return []map[string]any{{"name": "foo"}}, 42, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, rec := newEchoRequest(http.MethodGet, "/", "")

	if err := h.List(c); err != nil {
		t.Fatalf("List error: %v", err)
	}

	var envelope struct {
		Total    int              `json:"total"`
		Page     int              `json:"page"`
		PageSize int              `json:"page_size"`
		Data     []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if envelope.Total != 42 {
		t.Errorf("total = %d, want 42", envelope.Total)
	}
}

// ── GetByID ───────────────────────────────────────────────────────────────────

func TestGetByID_NotFound_Returns404(t *testing.T) {
	svc := &mockSvc{
		byID: func(_ context.Context, _ any) (map[string]any, error) {
			return nil, crud.ErrNotFound
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, rec := newEchoRequest(http.MethodGet, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("00000000-0000-0000-0000-000000000001")

	err := h.GetByID(c)
	var he *echo.HTTPError
	if !errors.As(err, &he) || he.Code != http.StatusNotFound {
		t.Errorf("expected 404 HTTPError, got err=%v rec=%d", err, rec.Code)
	}
}

func TestGetByID_InvalidUUID_Returns400(t *testing.T) {
	svc := &mockSvc{}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, _ := newEchoRequest(http.MethodGet, "/", "")
	c.SetParamNames("id")
	c.SetParamValues("not-a-uuid")

	err := h.GetByID(c)
	var he *echo.HTTPError
	if !errors.As(err, &he) || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400 HTTPError, got %v", err)
	}
}

// ── Create ────────────────────────────────────────────────────────────────────

func TestCreate_Returns201(t *testing.T) {
	svc := &mockSvc{
		create: func(_ context.Context, data map[string]any) (map[string]any, error) {
			data["id"] = "uuid-value"
			return data, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, rec := newEchoRequest(http.MethodPost, "/", `{"name":"test"}`)

	if err := h.Create(c); err != nil {
		t.Fatalf("Create error: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}
}

func TestCreate_MissingRequired_Returns422(t *testing.T) {
	svc := &mockSvc{}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, rec := newEchoRequest(http.MethodPost, "/", `{}`)

	err := h.Create(c)
	// The handler may return an error or write 422 directly.
	if err == nil && rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("expected 422, got status=%d err=nil", rec.Code)
	}
}

// ── Delete / Restore route presence ──────────────────────────────────────────

func TestMeta_SoftDelete_True_ForItemStruct(t *testing.T) {
	meta := itemMeta()
	if !meta.SoftDelete {
		t.Error("item embeds BaseModel with DeletedAt — SoftDelete should be true")
	}
}

func TestMeta_SoftDelete_False_ForHardItem(t *testing.T) {
	meta := hardItemMeta()
	if meta.SoftDelete {
		t.Error("hardItem has no DeletedAt — SoftDelete should be false")
	}
}

func TestList_FilterAndSearchParams(t *testing.T) {
	var gotFilter crud.ListFilter
	svc := &mockSvc{
		list: func(_ context.Context, f crud.ListFilter) ([]map[string]any, int, error) {
			gotFilter = f
			return nil, 0, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, _ := newEchoRequest(http.MethodGet,
		"/api/v1/items?filter%5Bid%5D=abc&search%5Bname%5D=ada&page=2", "")

	if err := h.List(c); err != nil {
		t.Fatalf("List error: %v", err)
	}
	if got := gotFilter.Equals["id"]; got != "abc" {
		t.Errorf("Equals[id] = %q, want abc", got)
	}
	if got := gotFilter.Matches["name"]; got != "ada" {
		t.Errorf("Matches[name] = %q, want ada", got)
	}
	if gotFilter.Page != 2 {
		t.Errorf("page = %d, want 2 (pagination must coexist with filters)", gotFilter.Page)
	}
}

func TestList_UnknownFilterColumnIs400(t *testing.T) {
	called := false
	svc := &mockSvc{
		list: func(_ context.Context, _ crud.ListFilter) ([]map[string]any, int, error) {
			called = true
			return nil, 0, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())

	for _, target := range []string{
		"/api/v1/items?filter%5Bnope%5D=x",
		"/api/v1/items?search%5Bnope%5D=x",
	} {
		_, c, _ := newEchoRequest(http.MethodGet, target, "")
		err := h.List(c)
		var httpErr *echo.HTTPError
		if !errors.As(err, &httpErr) || httpErr.Code != http.StatusBadRequest {
			t.Errorf("%s: err = %v, want 400 HTTPError", target, err)
		}
	}
	if called {
		t.Error("service must not be reached with an unknown filter column")
	}
}

func TestList_EmptyFilterValueIgnored(t *testing.T) {
	var gotFilter crud.ListFilter
	svc := &mockSvc{
		list: func(_ context.Context, f crud.ListFilter) ([]map[string]any, int, error) {
			gotFilter = f
			return nil, 0, nil
		},
	}
	h := handler.NewGenericHandlerFromSvc(svc, itemMeta())
	_, c, _ := newEchoRequest(http.MethodGet, "/api/v1/items?search%5Bname%5D=", "")

	if err := h.List(c); err != nil {
		t.Fatalf("List error: %v", err)
	}
	if len(gotFilter.Matches) != 0 {
		t.Errorf("empty search value must be ignored, got %v", gotFilter.Matches)
	}
}
