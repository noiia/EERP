package propertymanagement

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/company"
	"core/internal/settings"
	"core/internal/testdb"
	"core/modules/sale"
	"core/modules/warehouse"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func pmCall(t *testing.T, h echo.HandlerFunc, id, body string) int {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.SetIdentity(req.Context(), auth.Identity{UserID: uuid.New(), TenantID: uuid.New()}))
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if id != "" {
		c.SetPathValues(echo.PathValues{{Name: "id", Value: id}})
	}
	if err := h(c); err != nil {
		e.HTTPErrorHandler(c, err)
	}
	return rec.Code
}

// The property management write overrides refuse what they can't parse, and a
// database that can't be reached is a 500 or a 404 — never a 2xx.
func TestHandler_RefusalsAndDatabaseDown(t *testing.T) {
	if err := (&propertyManagementModule{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}
	db := testdb.Closed(t).DB
	h := NewHandler(
		orm.MustRepo[PropertyManagement](db),
		orm.MustRepo[PropertyManagementEquipment](db),
		orm.MustRepo[PropertyManagementEquipmentStatus](db),
		orm.MustRepo[PropertyManagementBillingLine](db),
		orm.MustRepo[PropertyManagementBillingLineTax](db),
		orm.MustRepo[sale.SaleTax](db),
		orm.MustRepo[PropertyManagementRentReceipt](db),
		orm.MustRepo[PropertyManagementRentReceiptLine](db),
		orm.MustRepo[warehouse.ProductUoms](db),
		settings.NewRepository(db),
		company.NewRepository(db),
	)
	uom := uuid.NewString()
	cases := []struct {
		name string
		call echo.HandlerFunc
		id   string
		body string
		want int
	}{
		{"create property: malformed", h.CreateProperty, "", `{`, http.StatusBadRequest},
		{"create property: unit can't be resolved", h.CreateProperty, "", `{"name":"Flat"}`, http.StatusInternalServerError},
		{"create property: write fails", h.CreateProperty, "", `{"name":"Flat","uom_id":"` + uom + `"}`, http.StatusInternalServerError},
		{"get property: bad id", h.GetProperty, "nope", "", http.StatusBadRequest},
		{"equipment status: malformed", h.CreateEquipmentStatus, "", `{`, http.StatusBadRequest},
		{"equipment status: unknown equipment", h.CreateEquipmentStatus, "", `{}`, http.StatusNotFound},
		{"billing line: malformed", h.CreateBillingLine, "", `{`, http.StatusBadRequest},
		{"billing line: tax mode unreadable", h.CreateBillingLine, "", `{"name":"Rent","unit_price":10}`, http.StatusInternalServerError},
		{"update billing line: bad id", h.UpdateBillingLine, "nope", `{}`, http.StatusBadRequest},
		{"update billing line: unknown", h.UpdateBillingLine, uuid.NewString(), `{}`, http.StatusNotFound},
		{"billing line tax: malformed", h.CreateBillingLineTax, "", `{`, http.StatusBadRequest},
		{"billing line tax: unknown line", h.CreateBillingLineTax, "", `{}`, http.StatusNotFound},
		{"delete billing line tax: bad id", h.DeleteBillingLineTax, "nope", "", http.StatusBadRequest},
		{"delete billing line tax: unknown", h.DeleteBillingLineTax, uuid.NewString(), "", http.StatusNotFound},
		{"receipt line: malformed", h.CreateRentReceiptLine, "", `{`, http.StatusBadRequest},
		{"receipt line: unknown receipt", h.CreateRentReceiptLine, "", `{}`, http.StatusNotFound},
		{"receipt delete is refused", h.RejectReceiptDelete, uuid.NewString(), "", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code := pmCall(t, tc.call, tc.id, tc.body); code != tc.want {
				t.Fatalf("status = %d, want %d", code, tc.want)
			}
		})
	}
}
