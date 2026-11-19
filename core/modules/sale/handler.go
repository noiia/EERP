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
	"github.com/labstack/echo/v5"
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
	productTaxes  *orm.Repository[ProductTax]
	uoms          *orm.Repository[warehouse.ProductUoms]
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
	productTaxes *orm.Repository[ProductTax],
	uoms *orm.Repository[warehouse.ProductUoms],
	settingsStore *settings.Repository,
	companies *company.Repository,
) *Handler {
	return &Handler{
		lines: lines, invoices: invoices, variants: variants, products: products,
		taxes: taxes, lineTaxes: lineTaxes, productTaxes: productTaxes, uoms: uoms,
		settingsStore: settingsStore, companies: companies,
	}
}

// taxIncluded reports whether the caller's workspace currently prices with
// tax baked in (Settings -> Global settings -> Tax) — see
// internal/settings.ResolveTaxIncluded and computeLineTotal below.
func (h *Handler) taxIncluded(ctx context.Context, identity auth.Identity) (bool, error) {
	return settings.ResolveTaxIncluded(ctx, h.settingsStore, h.companies, identity.TenantID, identity.UserID)
}

// Create handles POST /api/v1/sale_line.
func (h *Handler) Create(c *echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body SaleLine
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID
	if _, err := findOwned(ctx, h.invoices, body.InvoiceID, identity.TenantID); err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Invoice not found.")
	}

	productID, err := h.snapshotFromVariant(ctx, identity.TenantID, &body)
	if err != nil {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error())
	}
	// The line starts with its product's taxes (product_tax.go), linked
	// right after the insert — a sale_line_tax row needs the line's id.
	taxes, err := productTaxes(ctx, h.productTaxes, h.taxes, identity.TenantID, productID)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not read the product's taxes.")
	}
	included, err := h.taxIncluded(ctx, identity)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not resolve the tax price mode.")
	}
	body.Subtotal, body.Total = computeLineTotal(body.Quantity*body.UnitPrice, body.TaxRate, taxes, included)

	created, err := h.lines.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the line.")
	}
	if err := linkLineTaxes(ctx, h.lineTaxes, identity.TenantID, created.ID, taxes); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not link the line's taxes.")
	}
	if err := h.recomputeTotals(ctx, identity.TenantID, created.InvoiceID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update invoice totals.")
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.lines, created))
}

// Update handles PUT /api/v1/sale_line/:id. VariantID and/or Quantity may
// change; Unit/TaxRate/UnitPrice are always re-snapshotted from the
// (possibly new) variant's product — never left stale from a prior edit.
func (h *Handler) Update(c *echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := findOwned(ctx, h.lines, id, identity.TenantID)
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

	productID, err := h.snapshotFromVariant(ctx, identity.TenantID, &merged)
	if err != nil {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error())
	}
	// Another variant: the line's taxes become the new product's. A plain
	// quantity edit keeps whatever taxes are linked (the user may have
	// tagged or untagged some since).
	if merged.VariantID != existing.VariantID {
		if err := h.relinkProductTaxes(ctx, identity.TenantID, id, productID); err != nil {
			return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not link the line's taxes.")
		}
	}
	taxes, err := h.linkedTaxes(ctx, identity.TenantID, id)
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
	if err := h.recomputeTotals(ctx, identity.TenantID, updated.InvoiceID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update invoice totals.")
	}

	return c.JSON(http.StatusOK, toColumnMap(h.lines, updated))
}

// Delete handles DELETE /api/v1/sale_line/:id — same soft-delete the
// generic handler would perform, plus the invoice rollup the generic
// handler has no way to trigger.
func (h *Handler) Delete(c *echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := findOwned(ctx, h.lines, id, identity.TenantID)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Line not found.")
	}

	if _, err := h.lines.Delete(ctx, id); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not delete the line.")
	}
	if err := h.recomputeTotals(ctx, identity.TenantID, existing.InvoiceID); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update invoice totals.")
	}

	return c.NoContent(http.StatusNoContent)
}

// CreateLineTax handles POST /api/v1/sale_line_tax — tags a tax onto a line.
// Hand-mounted (not generic) purely so linking recomputes the line's own
// Total, then rolls that up onto the invoice, same cascade shape as
// sale_line's own Create/Update/Delete above.
func (h *Handler) CreateLineTax(c *echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	var body SaleLineTax
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID
	if _, err := findOwned(ctx, h.lines, body.SaleLineID, identity.TenantID); err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Line not found.")
	}
	if _, err := findOwned(ctx, h.taxes, body.SaleTaxID, identity.TenantID); err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Tax not found.")
	}

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
func (h *Handler) DeleteLineTax(c *echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	ctx := c.Request().Context()

	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}

	existing, err := findOwned(ctx, h.lineTaxes, id, identity.TenantID)
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
	line, err := findOwned(ctx, h.lines, lineID, identity.TenantID)
	if err != nil {
		return err
	}
	taxes, err := h.linkedTaxes(ctx, identity.TenantID, lineID)
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
	return h.recomputeTotals(ctx, identity.TenantID, line.InvoiceID)
}

// linkedTaxes resolves a line's own sale_line_tax rows into the SaleTax
// records they point at (see ResolveTaxes).
func (h *Handler) linkedTaxes(ctx context.Context, tenant, lineID uuid.UUID) ([]SaleTax, error) {
	links, err := h.lineTaxes.FindAll(ctx, orm.Cond("sale_line_id = $1 AND tenant_id = $2", lineID, tenant))
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(links))
	for i, link := range links {
		ids[i] = link.SaleTaxID
	}
	return ResolveTaxes(ctx, h.taxes, tenant, ids)
}

// ResolveTaxes loads the SaleTax each id points at in ONE query (instead of
// one FindByID per link), returned in ids order with duplicates kept. A
// dangling id (the tax was deleted) is silently skipped rather than failing
// the whole computation — "best effort over a stale reference", same posture
// module.go's other snapshot fields take — and so is a tax of another tenant.
// Shared with propertymanagement's billing lines.
func ResolveTaxes(ctx context.Context, taxes *orm.Repository[SaleTax], tenant uuid.UUID, ids []uuid.UUID) ([]SaleTax, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	found, err := taxes.FindAll(ctx, orm.Cond("id = ANY($1) AND tenant_id = $2", ids, tenant))
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]SaleTax, len(found))
	for _, t := range found {
		byID[t.ID] = t
	}
	out := make([]SaleTax, 0, len(ids))
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			out = append(out, t)
		}
	}
	return out, nil
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
func (h *Handler) snapshotFromVariant(ctx context.Context, tenant uuid.UUID, line *SaleLine) (uuid.UUID, error) {
	variant, err := findOwned(ctx, h.variants, line.VariantID, tenant)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, fmt.Errorf("variant_id must reference an existing product variant")
		}
		return uuid.Nil, err
	}
	product, err := findOwned(ctx, h.products, variant.ProductID, tenant)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, fmt.Errorf("the variant's product no longer exists")
		}
		return uuid.Nil, err
	}
	line.VariantName = variant.Name
	if line.UomID, line.Unit, err = resolveLineUnit(ctx, h.uoms, tenant, line.UomID, product.UomID); err != nil {
		return uuid.Nil, err
	}
	// The product's taxes are linked separately (sale_line_tax); tax_rate
	// carries only the variant's own extra rate.
	line.TaxRate = variantRate(variant)
	line.UnitPrice = resolveUnitPrice(product, variant)
	return product.ID, nil
}

// relinkProductTaxes replaces a line's tax links with its (new) product's.
func (h *Handler) relinkProductTaxes(ctx context.Context, tenant, lineID, productID uuid.UUID) error {
	old, err := h.lineTaxes.FindAll(ctx, orm.Cond("sale_line_id = $1 AND tenant_id = $2", lineID, tenant))
	if err != nil {
		return err
	}
	for _, l := range old {
		if _, err := h.lineTaxes.Delete(ctx, l.ID); err != nil {
			return err
		}
	}
	taxes, err := productTaxes(ctx, h.productTaxes, h.taxes, tenant, productID)
	if err != nil {
		return err
	}
	return linkLineTaxes(ctx, h.lineTaxes, tenant, lineID, taxes)
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

// recomputeTotals sums every active line on the invoice into
// Subtotal/TaxAmount/Total — "the total free taxes, [under it] the taxes
// amount depending on each product's own taxes and prices, and finally the
// total." Runs after every sale_line Create/Update/Delete so the invoice's
// stored columns (what the PDF report actually reads) never go stale.
func (h *Handler) recomputeTotals(ctx context.Context, tenant, invoiceID uuid.UUID) error {
	lines, err := h.lines.FindAll(ctx, orm.Cond("invoice_id = $1 AND tenant_id = $2", invoiceID, tenant))
	if err != nil {
		return err
	}

	invoice, err := findOwned(ctx, h.invoices, invoiceID, tenant)
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

// findOwned reads one row by id within the caller's tenant. Every lookup in
// handler.go and quote_handler.go goes through it (and every FindAll carries
// a tenant_id condition): the typed repositories don't scope by tenant the
// way the generic CRUD layer does, so an id alone — from the path or a
// request body — would reach, and for the writes modify, another
// workspace's row. A row of another tenant reads as not found
// (pgx.ErrNoRows, like a missing one).
// resolveLineUnit picks a line's unit of measure — the one it names, else its
// product's — and the label the line items table and the PDF print for it
// (the symbol, else the name). A unit the line names must exist (a client
// error otherwise); a product's unit that no longer does is just dropped, so
// a deleted unit never blocks selling the product.
func resolveLineUnit(
	ctx context.Context,
	uoms *orm.Repository[warehouse.ProductUoms],
	tenant uuid.UUID,
	lineUom, productUom *uuid.UUID,
) (*uuid.UUID, string, error) {
	id := lineUom
	if id == nil {
		id = productUom
	}
	if id == nil {
		return nil, "", nil
	}
	uom, err := findOwned(ctx, uoms, *id, tenant)
	if errors.Is(err, pgx.ErrNoRows) {
		if lineUom != nil {
			return nil, "", fmt.Errorf("uom_id must reference an existing unit of measure")
		}
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	if uom.Symbol != "" {
		return id, uom.Symbol, nil
	}
	return id, uom.Name, nil
}

func findOwned[T any](ctx context.Context, repo *orm.Repository[T], id, tenant uuid.UUID) (T, error) {
	return repo.FindOne(ctx, orm.Cond("id = $1 AND tenant_id = $2", id, tenant))
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

func errorJSON(c *echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
