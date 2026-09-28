package app

import (
	"reflect"
	"strings"
	"testing"

	"core/internal/auth"
	"core/internal/cron"
	"core/modules/crminheritdemo"
	"core/modules/propertymanagement"
	"core/modules/sale"
	"core/modules/warehouse"
	"core/orm/model"
)

// The override handlers mounted in mountRoutes decode request bodies with
// c.Bind (encoding/json) into these structs, while the frontend sends the
// generic CRUD surface's keys: db column names. A multi-word column without a
// matching json tag (ActionID vs "action_id") is silently dropped — cron's
// action and crm's contact were. Every body type an override binds belongs here.
func TestBoundBodies_JSONKeysMatchColumns(t *testing.T) {
	bodies := []any{
		cron.Cron{},
		auth.RoleViewPermission{}, auth.RoleViewPermissionRight{},
		crminheritdemo.CRM{},
		sale.SaleLine{}, sale.SaleLineTax{}, sale.QuoteLine{},
		warehouse.ProductVariant{},
		propertymanagement.PropertyManagementEquipmentStatus{},
		propertymanagement.PropertyManagementBillingLine{},
		propertymanagement.PropertyManagementBillingLineTax{},
		propertymanagement.PropertyManagementRentReceiptLine{},
	}
	baseModel := reflect.TypeOf(model.BaseModel{}) // server-controlled columns, never bound
	var check func(t *testing.T, typ reflect.Type)
	check = func(t *testing.T, typ reflect.Type) {
		for i := range typ.NumField() {
			f := typ.Field(i)
			if f.Anonymous {
				if f.Type != baseModel {
					check(t, f.Type)
				}
				continue
			}
			col, _, _ := strings.Cut(f.Tag.Get("db"), ",")
			if col == "" || col == "-" {
				continue
			}
			key, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if key == "" {
				key = f.Name // encoding/json's case-insensitive fallback
			}
			if !strings.EqualFold(key, col) {
				t.Errorf("%s.%s: column %q is read from JSON key %q — add `json:%q`", typ.Name(), f.Name, col, key, col)
			}
		}
	}
	for _, b := range bodies {
		typ := reflect.TypeOf(b)
		t.Run(typ.Name(), func(t *testing.T) { check(t, typ) })
	}
}
