package sale

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"

	"core/internal/auth"
	"core/internal/company"
	"core/internal/settings"
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
	lines         *orm.Repository[SaleLine]
	invoices      *orm.Repository[Invoice]
	variants      *orm.Repository[warehouse.ProductVariant]
	products      *orm.Repository[warehouse.Product]
	taxes         *orm.Repository[SaleTax]
	lineTaxes     *orm.Repository[SaleLineTax]
	settingsStore *settings.Repository
	companies     *company.Repository
}

func NewHandler(
	lines *orm.Repository[SaleLine],
	invoices *orm.Repository[Invoice],
	variants *orm.Repository[warehouse.ProductVariant],
	products *orm.Repository[warehouse.Product],
	taxes *orm.Repository[SaleTax],
	lineTaxes *orm.Repository[SaleLineTax],
	settingsStore *settings.Repository,
	companies *company.Repository,
) *Handler {
	return &Handler{
		lines: lines, invoices: invoices, variants: variants, products: products,
		taxes: taxes, lineTaxes: lineTaxes, settingsStore: settingsStore, companies: companies,
	}
}

// taxIncluded reports whether the caller's workspace currently prices with
// tax baked in (Settings -> Global settings -> Tax) — see
// internal/settings.ResolveTaxIncluded and computeLineTotal below.
func (h *Handler) taxIncluded(ctx context.Context, identity auth.Identity) (bool, error) {
	return settings.ResolveTaxIncluded(ctx, h.settingsStore, h.companies, identity.TenantID, identity.UserID)
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
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not resolve the tax price mode.")
	}
	// No taxes can be linked yet (sale_line_tax rows reference this line's
	// own id, which doesn't exist until the Create below) — Total is just
	// the base price plus TaxRate. Tagging a tax afterward is what
	// recomputes it for real (CreateLineTax/DeleteLineTax below).
	body.Subtotal, body.Total = computeLineTotal(body.Quantity*body.UnitPrice, body.TaxRate, nil, included)

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
	// VariantID/Quantity may have just changed the base price — recompute
	// Total from whatever taxes are ALREADY linked (this endpoint never
	// touches sale_line_tax itself, so the tag set is untouched by a plain
	// field edit).
	taxes, err := h.linkedTaxes(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not read the line's taxes.")
	}
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not resolve the tax price mode.")
	}
	merged.Subtotal, merged.Total = computeLineTotal(merged.Quantity*merged.UnitPrice, merged.TaxRate, taxes, included)

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

// CreateLineTax handles POST /api/v1/sale_line_tax — tags a tax onto a line.
// Hand-mounted (not generic) purely so linking recomputes the line's own
// Total, then rolls that up onto the invoice, same cascade shape as
// sale_line's own Create/Update/Delete above.
func (h *Handler) CreateLineTax(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body SaleLineTax
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	created, err := h.lineTaxes.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not link the tax.")
	}
	if err := h.recomputeLineAndInvoice(ctx, identity, created.SaleLineID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the line's total.")
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.lineTaxes, created))
}

// DeleteLineTax handles DELETE /api/v1/sale_line_tax/:id — untags a tax,
// same recompute cascade as CreateLineTax above.
func (h *Handler) DeleteLineTax(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := h.lineTaxes.FindByID(ctx, id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Tax link not found.")
	}

	if _, err := h.lineTaxes.Delete(ctx, id); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not unlink the tax.")
	}
	if err := h.recomputeLineAndInvoice(ctx, identity, existing.SaleLineID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the line's total.")
	}

	return c.NoContent(http.StatusNoContent)
}

// recomputeLineAndInvoice re-derives one line's own Total from its
// (possibly just-changed) tax links, persists it, then rolls the invoice's
// own Subtotal/TaxAmount/Total back up — the cascade CreateLineTax/
// DeleteLineTax trigger.
func (h *Handler) recomputeLineAndInvoice(ctx context.Context, identity auth.Identity, lineID uuid.UUID) error {
	line, err := h.lines.FindByID(ctx, lineID)
	if err != nil {
		return err
	}
	taxes, err := h.linkedTaxes(ctx, lineID)
	if err != nil {
		return err
	}
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return err
	}
	line.Subtotal, line.Total = computeLineTotal(line.Quantity*line.UnitPrice, line.TaxRate, taxes, included)
	if _, err := h.lines.Update(ctx, line, lineID); err != nil {
		return err
	}
	return h.recomputeTotals(ctx, line.InvoiceID)
}

// linkedTaxes resolves a line's own sale_line_tax rows into the SaleTax
// records they point at. A dangling link (the tax was deleted) is silently
// skipped rather than failing the whole computation — same "best effort over
// a stale reference" posture module.go's other snapshot fields take.
func (h *Handler) linkedTaxes(ctx context.Context, lineID uuid.UUID) ([]SaleTax, error) {
	links, err := h.lineTaxes.FindAll(ctx, orm.Cond("sale_line_id = $1", lineID))
	if err != nil {
		return nil, err
	}
	taxes := make([]SaleTax, 0, len(links))
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

// computeLineTotal is the pure money math behind a line's own Subtotal/Total
// — pulled out so it's testable without a DB (see handler_test.go). base is
// quantity × unit_price; legacyRate is the line's own product-resolved
// TaxRate (module.go's SaleLine.Total doc comment: kept, not replaced);
// taxes are the tags on top, each either a percentage (of base) or a flat
// fixed amount. All three rate sources stack additively — a line can carry a
// product's own VAT AND an eco-tax tag AND a fixed stamp-duty tag at once.
//
// included selects which of base's two possible meanings applies (Settings
// -> Global settings -> Tax, internal/settings.TaxPriceModeKey):
//   - false (tax_excluded, the original behavior): base is already
//     tax-free — total is base plus every rate/fixed tax computed on top of
//     it ("12€ + 20% tax" -> 14.40€).
//   - true (tax_included): base is the FINAL, tax-inclusive price as
//     entered/resolved — total is simply base, and subtotal is solved for
//     backwards so the tax breakdown (invoice Subtotal/TaxAmount) still adds
//     up ("12€ including 20% tax" stays 12€, of which 10€ is the pre-tax
//     subtotal and 2€ is tax).
//
// Either way, subtotal*rate + fixed == total-subtotal: the same "stack of
// rate and fixed taxes over one base" model, solved in whichever direction
// included calls for.
func computeLineTotal(base, legacyRate float64, taxes []SaleTax, included bool) (subtotal, total float64) {
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
// testable without a DB (see handler_test.go). Reads each line's own
// ALREADY-COMPUTED Subtotal/Total (computeLineTotal, kept current by every
// sale_line/sale_line_tax mutation above) rather than re-deriving tax here —
// a line's tax can now be a mix of its product's own TaxRate plus any number
// of tagged SaleTax rows (percentage or fixed), which no longer collapses
// into a single "rate × base" a per-invoice sum could redo on its own, AND
// (since the tax.price_mode setting can change what a line's own UnitPrice
// even means) Quantity*UnitPrice is no longer a safe stand-in for Subtotal
// the way it was before that setting existed. taxAmount is back-derived as
// total-subtotal rather than stored per line twice.
func sumLines(lines []SaleLine) (subtotal, taxAmount, total float64) {
	for _, l := range lines {
		subtotal += l.Subtotal
		total += l.Total
	}
	taxAmount = total - subtotal
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
