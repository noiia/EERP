package propertymanagement

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"time"

	"core/internal/auth"
	"core/internal/company"
	"core/internal/settings"
	"core/modules/sale"
	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
//   - POST/PUT /api/v1/property_management_billing_line — computes the
//     line's own Total (unit_price + tax_rate + every tagged sale.SaleTax);
//     GET/DELETE stay generic.
//   - POST/DELETE /api/v1/property_management_billing_line_tax — tagging or
//     untagging a tax recomputes the owning billing line's Total, same
//     cascade shape as sale/handler.go's CreateLineTax/DeleteLineTax.
//   - POST /api/v1/property_management_rent_receipt_line — recomputes the
//     parent receipt's Subtotal/TaxAmount/Total from its own lines after
//     every insert (mirrors sale/handler.go's recomputeTotals) — the
//     "double check before the PDF is generated" the receipt-line snapshot
//     needs, since generateRentReceipt's own upfront sum
//     (property_management_views.ts) is just a client-side estimate.
type Handler struct {
	properties       *orm.Repository[PropertyManagement]
	equipment        *orm.Repository[PropertyManagementEquipment]
	statuses         *orm.Repository[PropertyManagementEquipmentStatus]
	billingLines     *orm.Repository[PropertyManagementBillingLine]
	billingLineTaxes *orm.Repository[PropertyManagementBillingLineTax]
	taxes            *orm.Repository[sale.SaleTax]
	rentReceipts     *orm.Repository[PropertyManagementRentReceipt]
	rentReceiptLines *orm.Repository[PropertyManagementRentReceiptLine]
	settingsStore    *settings.Repository
	companies        *company.Repository
}

func NewHandler(
	properties *orm.Repository[PropertyManagement],
	equipment *orm.Repository[PropertyManagementEquipment],
	statuses *orm.Repository[PropertyManagementEquipmentStatus],
	billingLines *orm.Repository[PropertyManagementBillingLine],
	billingLineTaxes *orm.Repository[PropertyManagementBillingLineTax],
	taxes *orm.Repository[sale.SaleTax],
	rentReceipts *orm.Repository[PropertyManagementRentReceipt],
	rentReceiptLines *orm.Repository[PropertyManagementRentReceiptLine],
	settingsStore *settings.Repository,
	companies *company.Repository,
) *Handler {
	return &Handler{
		properties:       properties,
		equipment:        equipment,
		statuses:         statuses,
		billingLines:     billingLines,
		billingLineTaxes: billingLineTaxes,
		taxes:            taxes,
		rentReceipts:     rentReceipts,
		rentReceiptLines: rentReceiptLines,
		settingsStore:    settingsStore,
		companies:        companies,
	}
}

// taxIncluded mirrors sale/handler.go's own Handler.taxIncluded exactly —
// see its doc comment.
func (h *Handler) taxIncluded(ctx context.Context, identity auth.Identity) (bool, error) {
	return settings.ResolveTaxIncluded(ctx, h.settingsStore, h.companies, identity.TenantID, identity.UserID)
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

// CreateBillingLine handles POST /api/v1/property_management_billing_line.
// No taxes can be linked yet (property_management_billing_line_tax rows
// reference this line's own id, which doesn't exist until Create below) —
// Total is just UnitPrice plus TaxRate, same "nothing to look up yet" shape
// as sale/handler.go's Handler.Create.
func (h *Handler) CreateBillingLine(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body PropertyManagementBillingLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not resolve the tax price mode.")
	}
	body.Subtotal, body.Total = computeBillingLineTotal(body.UnitPrice, body.TaxRate, nil, included)

	created, err := h.billingLines.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the billing line.")
	}
	return c.JSON(http.StatusCreated, toColumnMap(h.billingLines, created))
}

// UpdateBillingLine handles PUT /api/v1/property_management_billing_line/:id.
// Partial-update semantics, same "zero in the body means unchanged"
// contract sale/handler.go's Handler.Update documents — Name/UnitPrice/
// TaxRate are the only client-editable fields.
func (h *Handler) UpdateBillingLine(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := h.billingLines.FindByID(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Billing line not found.")
	}

	var body PropertyManagementBillingLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	merged := existing
	merged.TenantID = identity.TenantID
	if body.Name != "" {
		merged.Name = body.Name
	}
	if body.UnitPrice != 0 {
		merged.UnitPrice = body.UnitPrice
	}
	if body.TaxRate != 0 {
		merged.TaxRate = body.TaxRate
	}

	taxes, err := h.linkedBillingLineTaxes(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not read the line's taxes.")
	}
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not resolve the tax price mode.")
	}
	merged.Subtotal, merged.Total = computeBillingLineTotal(merged.UnitPrice, merged.TaxRate, taxes, included)

	updated, err := h.billingLines.Update(ctx, merged, id)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the billing line.")
	}
	return c.JSON(http.StatusOK, toColumnMap(h.billingLines, updated))
}

// CreateBillingLineTax handles POST /api/v1/property_management_billing_line_tax
// — tags a tax onto a billing line, then recomputes that line's own Total.
func (h *Handler) CreateBillingLineTax(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body PropertyManagementBillingLineTax
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	created, err := h.billingLineTaxes.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not link the tax.")
	}
	if err := h.recomputeBillingLineTotal(ctx, identity, created.PropertyManagementBillingLineID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the line's total.")
	}
	return c.JSON(http.StatusCreated, toColumnMap(h.billingLineTaxes, created))
}

// DeleteBillingLineTax handles DELETE /api/v1/property_management_billing_line_tax/:id
// — untags a tax, same recompute as CreateBillingLineTax above.
func (h *Handler) DeleteBillingLineTax(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := h.billingLineTaxes.FindByID(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Tax link not found.")
	}

	if _, err := h.billingLineTaxes.Delete(ctx, id); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not unlink the tax.")
	}
	if err := h.recomputeBillingLineTotal(ctx, identity, existing.PropertyManagementBillingLineID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the line's total.")
	}
	return c.NoContent(http.StatusNoContent)
}

// recomputeBillingLineTotal re-derives one billing line's own Total from its
// (possibly just-changed) tax links and persists it. No parent-document
// cascade beyond this — unlike sale_line's own recompute, a
// PropertyManagement has no stored aggregate of its own (billing_totals is a
// live, store:false frontend compute — property_management_views.ts).
func (h *Handler) recomputeBillingLineTotal(ctx context.Context, identity auth.Identity, lineID uuid.UUID) error {
	line, err := h.billingLines.FindByID(ctx, lineID)
	if err != nil {
		return err
	}
	taxes, err := h.linkedBillingLineTaxes(ctx, lineID)
	if err != nil {
		return err
	}
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return err
	}
	line.Subtotal, line.Total = computeBillingLineTotal(line.UnitPrice, line.TaxRate, taxes, included)
	_, err = h.billingLines.Update(ctx, line, lineID)
	return err
}

// linkedBillingLineTaxes resolves a billing line's own
// property_management_billing_line_tax rows into the sale.SaleTax records
// they point at. A dangling link (the tax was deleted) is silently skipped
// rather than failing the whole computation — mirrors sale/handler.go's own
// linkedTaxes.
func (h *Handler) linkedBillingLineTaxes(ctx context.Context, lineID uuid.UUID) ([]sale.SaleTax, error) {
	links, err := h.billingLineTaxes.FindAll(ctx, orm.Cond("property_management_billing_line_id = $1", lineID))
	if err != nil {
		return nil, err
	}
	taxes := make([]sale.SaleTax, 0, len(links))
	for _, link := range links {
		tax, err := h.taxes.FindByID(ctx, link.SaleTaxID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		taxes = append(taxes, tax)
	}
	return taxes, nil
}

// computeBillingLineTotal is the pure money math behind a billing line's own
// Subtotal/Total — pulled out so it's testable without a DB (see
// handler_test.go). Mirrors sale/handler.go's computeLineTotal exactly
// (base is just UnitPrice here, no quantity concept — see module.go's
// PropertyManagementBillingLine doc comment), included switching between
// tax_excluded/tax_included the same way; duplicated rather than
// shared/exported across modules, same "small helper, one file each" posture
// toColumnMap/errorJSON already take in both handler.go files.
func computeBillingLineTotal(base, legacyRate float64, taxes []sale.SaleTax, included bool) (subtotal, total float64) {
	rate := legacyRate
	var fixed float64
	for _, t := range taxes {
		if t.Kind == "fixed" {
			fixed += t.Amount
		} else {
			rate += t.Rate
		}
	}
	if included {
		return (base - fixed) / (1 + rate), base
	}
	return base, base + base*rate + fixed
}

// CreateRentReceiptLine handles POST /api/v1/property_management_rent_receipt_line
// — after inserting the line (generateRentReceipt's snapshot copy,
// property_management_views.ts), recomputes the parent receipt's own
// Subtotal/TaxAmount/Total from ALL its lines so far. Every line a receipt
// gets is created in a tight loop right after the receipt row itself, so by
// the time fetchReportPDF runs (after the loop), these columns are the
// real, backend-verified numbers — not whatever the frontend's own upfront
// estimate guessed when it created the receipt row.
func (h *Handler) CreateRentReceiptLine(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body PropertyManagementRentReceiptLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	created, err := h.rentReceiptLines.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the receipt line.")
	}
	if err := h.recomputeReceiptTotals(ctx, created.RentReceiptID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the receipt's totals.")
	}
	return c.JSON(http.StatusCreated, toColumnMap(h.rentReceiptLines, created))
}

// recomputeReceiptTotals sums every line on a rent receipt into
// Subtotal/TaxAmount/Total — mirrors sale/handler.go's recomputeTotals
// exactly (a receipt line's own Subtotal/Total are already fully computed,
// copied verbatim from its source billing line at snapshot time — module.go's
// PropertyManagementRentReceiptLine doc comment — so there is nothing left
// to resolve here beyond summing). Sums each line's own Subtotal rather than
// UnitPrice: once tax.price_mode is tax_included, UnitPrice alone no longer
// tells you the tax-excluded figure.
func (h *Handler) recomputeReceiptTotals(ctx context.Context, receiptID uuid.UUID) error {
	lines, err := h.rentReceiptLines.FindAll(ctx, orm.Cond("rent_receipt_id = $1", receiptID))
	if err != nil {
		return err
	}
	receipt, err := h.rentReceipts.FindByID(ctx, receiptID)
	if err != nil {
		return err
	}

	var subtotal, total float64
	for _, l := range lines {
		subtotal += l.Subtotal
		total += l.Total
	}
	receipt.Subtotal = subtotal
	receipt.TaxAmount = total - subtotal
	receipt.Total = total

	_, err = h.rentReceipts.Update(ctx, receipt, receiptID)
	return err
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
