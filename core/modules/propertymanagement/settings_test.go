package propertymanagement

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/settings"
	"core/internal/testdb"
	_ "core/modules/settings"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func serveSettings(t *testing.T, h echo.HandlerFunc, method, body string, identity auth.Identity, id string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), identity))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(append(c.PathValues(), echo.PathValue{Name: "id", Value: id}))
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec
}

// "Display taxes on report" defaults to off, round-trips through PUT, and
// reaches the rent receipt read as display_taxes — only for the receipt's
// own tenant.
func TestDisplayTaxesOnReport(t *testing.T) {
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "settings", "propertymanagement")
	tenant, other := uuid.New(), uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{"app_settings", "property_management_rent_receipt"} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = ANY($1)`, []uuid.UUID{tenant, other})
		}
	})
	receipts := orm.MustRepo[PropertyManagementRentReceipt](app.DB)
	receipt, err := receipts.Create(ctx, PropertyManagementRentReceipt{
		BaseModel: model.BaseModel{TenantID: tenant}, Period: "2026-10",
	})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{rentReceipts: receipts, settingsStore: settings.NewRepository(app.DB)}
	me := auth.Identity{TenantID: tenant, UserID: uuid.New()}

	displayTaxes := func(identity auth.Identity) (any, int) {
		rec := serveSettings(t, h.GetRentReceipt, http.MethodGet, "", identity, receipt.ID.String())
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out["display_taxes"], rec.Code
	}

	rec := serveSettings(t, h.GetSettings, http.MethodGet, "", me, "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"display_taxes_on_report":false}` {
		t.Fatalf("default settings = %d %s, want off", rec.Code, rec.Body.String())
	}
	if got, code := displayTaxes(me); code != http.StatusOK || got != false {
		t.Fatalf("display_taxes before saving = %v (%d), want false", got, code)
	}

	if rec := serveSettings(t, h.PutSettings, http.MethodPut, `{"display_taxes_on_report":true}`, me, ""); rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d %s", rec.Code, rec.Body.String())
	}
	if got, _ := displayTaxes(me); got != true {
		t.Errorf("display_taxes after turning it on = %v, want true", got)
	}

	if _, code := displayTaxes(auth.Identity{TenantID: other, UserID: uuid.New()}); code != http.StatusNotFound {
		t.Errorf("another tenant reading the receipt got %d, want 404", code)
	}
	if rec := serveSettings(t, h.PutSettings, http.MethodPut, `not json`, me, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("malformed PUT = %d, want 400", rec.Code)
	}
}
