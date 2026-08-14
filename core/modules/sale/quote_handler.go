package sale

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"core/internal/auth"
	"core/modules/warehouse"
	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
)

// QuoteHandler mirrors Handler exactly (sale_line's Create/Update/Delete
// overrides), scoped to quote_line/Quote instead of sale_line/Invoice — see
// Handler's doc comment for why every mutation needs interception. Kept as a
// separate type rather than a generic over both document kinds: the two
// pairs are small, boring, and not sharing this indirection keeps each
// readable on its own.
type QuoteHandler struct {
	lines    *orm.Repository[QuoteLine]
	quotes   *orm.Repository[Quote]
	variants *orm.Repository[warehouse.ProductVariant]
	products *orm.Repository[warehouse.Product]
}

func NewQuoteHandler(
	lines *orm.Repository[QuoteLine],
	quotes *orm.Repository[Quote],
	variants *orm.Repository[warehouse.ProductVariant],
	products *orm.Repository[warehouse.Product],
) *QuoteHandler {
	return &QuoteHandler{lines: lines, quotes: quotes, variants: variants, products: products}
}

// Create handles POST /api/v1/quote_line.
func (h *QuoteHandler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body QuoteLine
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
	if err := h.recomputeTotals(ctx, created.QuoteID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update quote totals.")
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.lines, created))
}

// Update handles PUT /api/v1/quote_line/:id.
func (h *QuoteHandler) Update(c echo.Context) error {
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

	var body QuoteLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	// Partial-update semantics, same as sale_line: a zero-value in the body
	// means "unchanged", not "clear it".
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
	if err := h.recomputeTotals(ctx, updated.QuoteID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update quote totals.")
	}

	return c.JSON(http.StatusOK, toColumnMap(h.lines, updated))
}

// Delete handles DELETE /api/v1/quote_line/:id.
func (h *QuoteHandler) Delete(c echo.Context) error {
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
	if err := h.recomputeTotals(ctx, existing.QuoteID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update quote totals.")
	}

	return c.NoContent(http.StatusNoContent)
}

// snapshotFromVariant mirrors Handler.snapshotFromVariant for QuoteLine.
func (h *QuoteHandler) snapshotFromVariant(ctx context.Context, line *QuoteLine) error {
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

// recomputeTotals mirrors Handler.recomputeTotals for Quote/QuoteLine.
func (h *QuoteHandler) recomputeTotals(ctx context.Context, quoteID uuid.UUID) error {
	lines, err := h.lines.FindAll(ctx, orm.Cond("quote_id = $1", quoteID))
	if err != nil {
		return err
	}

	quote, err := h.quotes.FindByID(ctx, quoteID)
	if err != nil {
		return err
	}
	subtotal, taxAmount, total := sumQuoteLines(lines)

	quote.Subtotal = &subtotal
	quote.TaxAmount = &taxAmount
	quote.Total = &total

	_, err = h.quotes.Update(ctx, quote, quoteID)
	return err
}

// sumQuoteLines mirrors sumLines for QuoteLine.
func sumQuoteLines(lines []QuoteLine) (subtotal, taxAmount, total float64) {
	for _, l := range lines {
		lineTotal := l.Quantity * l.UnitPrice
		subtotal += lineTotal
		taxAmount += lineTotal * l.TaxRate
	}
	total = subtotal + taxAmount
	return subtotal, taxAmount, total
}
