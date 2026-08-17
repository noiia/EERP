package propertymanagement

import (
	"context"
	"net/http"
	"reflect"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// monthLayout is the "2026-08"-shaped format LastReceiptMonth/Period use
// throughout this module — a plain calendar-month string, not a timestamp,
// since a receipt covers a whole month rather than a point in time.
const monthLayout = "2006-01"

// Handler serves the routes this module overrides on top of the generic
// CRUD surface (mirrors modules/cron/handler.go's "ride the generic
// surface, override only what needs it" shape):
//   - GET  /api/v1/property_management/:id — injects a computed,
//     non-stored receipt_generated_this_month key the "Generate Rent
//     Receipt" header button's states.readOnly condition reads (see
//     module.go's PropertyManagement.LastReceiptMonth doc comment).
//   - POST /api/v1/property_management_equipment_status — after creating
//     a status entry, rolls its State up onto the parent Equipment's
//     CurrentState (same "child row changes, parent rollup recomputes"
//     shape as modules/sale/handler.go's recomputeTotals).
//   - PUT/DELETE /api/v1/property_management_rent_receipt/:id — always
//     reject. A receipt is append-only (created only by the Generate Rent
//     Receipt flow, task #21) — mirrors internal/chatter's append-only
//     posture, enforced here rather than just by hiding the UI control.
type Handler struct {
	properties *orm.Repository[PropertyManagement]
	equipment  *orm.Repository[PropertyManagementEquipment]
	statuses   *orm.Repository[PropertyManagementEquipmentStatus]
}

func NewHandler(
	properties *orm.Repository[PropertyManagement],
	equipment *orm.Repository[PropertyManagementEquipment],
	statuses *orm.Repository[PropertyManagementEquipmentStatus],
) *Handler {
	return &Handler{properties: properties, equipment: equipment, statuses: statuses}
}

// GetProperty handles GET /api/v1/property_management/:id.
func (h *Handler) GetProperty(c echo.Context) error {
	ctx := c.Request().Context()

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	property, err := h.properties.FindByID(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Property not found.")
	}

	out := toColumnMap(h.properties, property)
	out["receipt_generated_this_month"] = receiptGeneratedThisMonth(property.LastReceiptMonth, time.Now())
	return c.JSON(http.StatusOK, out)
}

// receiptGeneratedThisMonth is a pure function (no DB/HTTP) so the nil case
// (never generated — module.go's LastReceiptMonth is a pointer specifically
// so CREATE doesn't need a value for it) is testable on its own, mirroring
// latestStatus below.
func receiptGeneratedThisMonth(lastReceiptMonth *string, now time.Time) bool {
	return lastReceiptMonth != nil && *lastReceiptMonth == now.Format(monthLayout)
}

// CreateEquipmentStatus handles POST /api/v1/property_management_equipment_status.
func (h *Handler) CreateEquipmentStatus(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body PropertyManagementEquipmentStatus
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	created, err := h.statuses.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the status entry.")
	}

	if err := h.rollupCurrentState(ctx, created.PropertyManagementEquipmentID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the equipment's current state.")
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.statuses, created))
}

// rollupCurrentState sets Equipment.CurrentState to the latest status
// entry's State (by Date) — recomputed from every entry rather than just
// trusting the one just created, so a backdated Date entered out of order
// still leaves CurrentState correct.
func (h *Handler) rollupCurrentState(ctx context.Context, equipmentID uuid.UUID) error {
	entries, err := h.statuses.FindAll(ctx, orm.Cond("property_management_equipment_id = $1", equipmentID))
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}

	equipment, err := h.equipment.FindByID(ctx, equipmentID)
	if err != nil {
		return err
	}
	equipment.CurrentState = latestStatus(entries).State
	_, err = h.equipment.Update(ctx, equipment, equipmentID)
	return err
}

// latestStatus returns the entry with the latest Date — pulled out as a
// pure function (no DB) so the "out of order entry" tie-break is testable
// on its own, mirroring modules/sale/handler.go's resolveUnitPrice. entries
// must be non-empty. A nil Date never beats a set one.
func latestStatus(entries []PropertyManagementEquipmentStatus) PropertyManagementEquipmentStatus {
	latest := entries[0]
	for _, e := range entries[1:] {
		if e.Date != nil && (latest.Date == nil || e.Date.After(*latest.Date)) {
			latest = e
		}
	}
	return latest
}

// RejectReceiptMutation handles PUT and DELETE /api/v1/property_management_rent_receipt/:id
// — a receipt is append-only, so both always reject.
func (h *Handler) RejectReceiptMutation(c echo.Context) error {
	return errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Rent receipts are append-only; they cannot be edited or deleted.")
}

// toColumnMap mirrors the generic CRUD handler's JSON shape — snake_case db
// column names, not Go field names — using the same public metadata the
// query builders already reflect over (Repository.Meta()). See
// modules/sale/handler.go's twin helper for the full rationale.
func toColumnMap[T any](repo *orm.Repository[T], entity T) map[string]any {
	meta := repo.Meta()
	v := reflect.ValueOf(entity)
	out := make(map[string]any, len(meta.Fields))
	for _, f := range meta.Fields {
		out[f.Column] = f.FieldValue(v).Interface()
	}
	return out
}

func errorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
