package sale

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"

	"core/internal/auth"
	"core/modules/warehouse"
	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
)

// Handler serves the three routes this module overrides for sale_line:
// Create/Update/Delete. GET (list/get) stays fully generic — the invoice
// form's one2many line-items table (views/invoice_views.ts) reads it
// unmodified, same "override only what needs it" shape as
// modules/crminheritdemo/handler.go.
//
// Every mutation needs interception because a line's Unit/TaxRate/UnitPrice
// must be resolved from its product/variant (Create), possibly re-resolved
// (Update), and the parent invoice's Subtotal/TaxAmount/Total rollups must
// stay in sync with whichever lines exist afterward — see
// recomputeTotals. Bypassing the generic route also bypasses its
// tenant-scoping (core/orm/internal/crud, unreachable from here), so
// TenantID is forced from the JWT identity by hand, same as
// crminheritdemo/notebook/pictures already do.
type Handler struct {
	lines    *orm.Repository[SaleLine]
	invoices *orm.Repository[Invoice]
	variants *orm.Repository[warehouse.ProductVariant]
	products *orm.Repository[warehouse.Product]
}

func NewHandler(
	lines *orm.Repository[SaleLine],
	invoices *orm.Repository[Invoice],
	variants *orm.Repository[warehouse.ProductVariant],
	products *orm.Repository[warehouse.Product],
) *Handler {
	return &Handler{lines: lines, invoices: invoices, variants: variants, products: products}
}

// Create handles POST /api/v1/sale_line.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body SaleLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	if err := h.snapshotFromVariant(ctx, &body); err != nil {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error())
	}

	created, err := h.lines.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the line.")
	}
	if err := h.recomputeTotals(ctx, created.InvoiceID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update invoice totals.")
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.lines, created))
}

// Update handles PUT /api/v1/sale_line/:id. VariantID and/or Quantity may
// change; Unit/TaxRate/UnitPrice are always re-snapshotted from the
// (possibly new) variant's product — never left stale from a prior edit.
func (h *Handler) Update(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := h.lines.FindByID(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Line not found.")
	}

	var body SaleLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	// Partial-update semantics: only VariantID/Quantity are caller-editable
	// — everything else (tenant, invoice, snapshot fields) is derived, so a
	// zero-value in the body means "unchanged", not "clear it".
	merged := existing
	merged.TenantID = identity.TenantID
	if body.VariantID != uuid.Nil {
		merged.VariantID = body.VariantID
	}
	if body.Quantity != 0 {
		merged.Quantity = body.Quantity
	}

	if err := h.snapshotFromVariant(ctx, &merged); err != nil {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error())
	}

	updated, err := h.lines.Update(ctx, merged, id)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the line.")
	}
	if err := h.recomputeTotals(ctx, updated.InvoiceID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update invoice totals.")
	}

	return c.JSON(http.StatusOK, toColumnMap(h.lines, updated))
}

// Delete handles DELETE /api/v1/sale_line/:id — same soft-delete the
// generic handler would perform, plus the invoice rollup the generic
// handler has no way to trigger.
func (h *Handler) Delete(c echo.Context) error {
	ctx := c.Request().Context()

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := h.lines.FindByID(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Line not found.")
	}

	if _, err := h.lines.Delete(ctx, id); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not delete the line.")
	}
	if err := h.recomputeTotals(ctx, existing.InvoiceID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update invoice totals.")
	}

	return c.NoContent(http.StatusNoContent)
}

// snapshotFromVariant resolves line.VariantID -> ProductVariant -> Product
// and copies Unit/TaxRate/UnitPrice onto the line — "each product
// automatically references a variant" made concrete on the sale side: a
// line never carries stale or hand-typed pricing, only what its product (or,
// when the variant carries its own UnitPrice override, the variant) says
// right now, captured at the moment the line is written.
func (h *Handler) snapshotFromVariant(ctx context.Context, line *SaleLine) error {
	variant, err := h.variants.FindByID(ctx, line.VariantID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("variant_id must reference an existing product variant")
		}
		return err
	}
	product, err := h.products.FindByID(ctx, variant.ProductID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("the variant's product no longer exists")
		}
		return err
	}
	line.VariantName = variant.Name
	line.Unit = product.Unit
	line.TaxRate = resolveTaxRate(product, variant)
	line.UnitPrice = resolveUnitPrice(product, variant)
	return nil
}

// resolveUnitPrice is pulled out as a pure function (no DB, no HTTP) so the
// override precedence is testable on its own — see handler_test.go. The
// variant's own UnitPrice, when set, wins over the product's.
func resolveUnitPrice(product warehouse.Product, variant warehouse.ProductVariant) float64 {
	if variant.UnitPrice != nil {
		return *variant.UnitPrice
	}
	return product.UnitPrice
}

// resolveTaxRate mirrors resolveUnitPrice: the variant's own TaxRate
// override, when set, wins over the product's — "each line has its own tax
// percent," resolved from the specific variant sold rather than just its
// product.
func resolveTaxRate(product warehouse.Product, variant warehouse.ProductVariant) float64 {
	if variant.TaxRate != nil {
		return *variant.TaxRate
	}
	return product.TaxRate
}

// recomputeTotals sums every active line on the invoice into
// Subtotal/TaxAmount/Total — "the total free taxes, [under it] the taxes
// amount depending on each product's own taxes and prices, and finally the
// total." Runs after every sale_line Create/Update/Delete so the invoice's
// stored columns (what the PDF report actually reads) never go stale.
func (h *Handler) recomputeTotals(ctx context.Context, invoiceID uuid.UUID) error {
	lines, err := h.lines.FindAll(ctx, orm.Cond("invoice_id = $1", invoiceID))
	if err != nil {
		return err
	}

	invoice, err := h.invoices.FindByID(ctx, invoiceID)
	if err != nil {
		return err
	}
	subtotal, taxAmount, total := sumLines(lines)

	invoice.Subtotal = &subtotal
	invoice.TaxAmount = &taxAmount
	invoice.Total = &total

	_, err = h.invoices.Update(ctx, invoice, invoiceID)
	return err
}

// sumLines is the pure money math behind recomputeTotals, pulled out so it's
// testable without a DB (see handler_test.go). Each line's own tax rate
// (from its product/variant) taxes its own gross total independently — see
// views/reports/invoice_report.ts's totals recap, which groups these same lines by tax
// rate for display.
func sumLines(lines []SaleLine) (subtotal, taxAmount, total float64) {
	for _, l := range lines {
		lineTotal := l.Quantity * l.UnitPrice
		subtotal += lineTotal
		taxAmount += lineTotal * l.TaxRate
	}
	total = subtotal + taxAmount
	return subtotal, taxAmount, total
}

// toColumnMap mirrors the generic CRUD handler's JSON shape — snake_case db
// column names, not Go field names — using the same public metadata the
// query builders already reflect over (Repository.Meta()).
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
