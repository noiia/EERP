package sale

import (
	"context"
	"errors"
	"fmt"
	"time"

	"core/internal/settings"
	"core/modules/warehouse"
	"core/orm"

	"github.com/google/uuid"
)

// Invoices raised by other modules (event bookings) inside their own
// transaction, with no logged-in user: one line on one product variant,
// priced and taxed exactly like a line typed in the invoice form.

// InvoiceRequest describes a one-line invoice.
type InvoiceRequest struct {
	TenantID      uuid.UUID
	CustomerID    *uuid.UUID // a contact, when the customer has one
	CustomerName  string
	CustomerEmail string
	Subject       string
	VariantID     uuid.UUID
	Quantity      float64
	// UnitPrice overrides the variant's price (e.g. an event session's own price).
	UnitPrice *float64
}

// ErrNoVariant: the request's variant (or its product) doesn't exist in the tenant.
var ErrNoVariant = errors.New("sale: no such product variant")

// VariantPrice is the price a line on variantID would carry: the variant's
// own unit price, else its product's (excl. tax, like every stored price).
func VariantPrice(ctx context.Context, ex orm.Executor, tenant, variantID uuid.UUID) (float64, error) {
	_, product, variant, err := loadVariant(ctx, ex, tenant, variantID)
	if err != nil {
		return 0, err
	}
	return resolveUnitPrice(product, variant), nil
}

func loadVariant(ctx context.Context, ex orm.Executor, tenant, variantID uuid.UUID) (string, warehouse.Product, warehouse.ProductVariant, error) {
	var v warehouse.ProductVariant
	var p warehouse.Product
	err := ex.QueryRow(ctx, `
		SELECT v.name, v.unit_price, v.tax_rate, p.id, p.unit_price
		FROM product_variant v JOIN product p ON p.id = v.product_id
		WHERE v.id = $1 AND v.tenant_id = $2 AND p.tenant_id = $2 AND v.deleted_at IS NULL AND p.deleted_at IS NULL`, variantID, tenant).
		Scan(&v.Name, &v.UnitPrice, &v.TaxRate, &p.ID, &p.UnitPrice)
	if errors.Is(err, orm.ErrNotFound) {
		return "", p, v, ErrNoVariant
	}
	return v.Name, p, v, err
}

// workspaceTaxIncluded is the tenant's tax price mode with no user to resolve
// an active company from: the first company's setting stands for the workspace.
func workspaceTaxIncluded(ctx context.Context, ex orm.Executor, tenant uuid.UUID) (bool, error) {
	var mode string
	err := ex.QueryRow(ctx, `SELECT s.value FROM app_settings s JOIN company c ON c.id = s.company_id
		WHERE s.tenant_id = $1 AND s.key = $2 AND s.deleted_at IS NULL ORDER BY c.created_at LIMIT 1`,
		tenant, settings.TaxPriceModeKey).Scan(&mode)
	if errors.Is(err, orm.ErrNotFound) {
		return false, nil
	}
	return mode == settings.TaxPriceModeIncluded, err
}

// WorkspaceCurrency is the tenant's first company's currency ("" if none).
func WorkspaceCurrency(ctx context.Context, ex orm.Executor, tenant uuid.UUID) (string, error) {
	var cur string
	err := ex.QueryRow(ctx, `SELECT currency FROM company WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, tenant).Scan(&cur)
	if errors.Is(err, orm.ErrNotFound) {
		return "", nil
	}
	return cur, err
}

// CreateInvoice inserts a "sent" invoice with one line through ex (the
// caller's transaction), totals computed like the invoice form's.
func CreateInvoice(ctx context.Context, ex orm.Executor, req InvoiceRequest) (Invoice, error) {
	name, product, variant, err := loadVariant(ctx, ex, req.TenantID, req.VariantID)
	if err != nil {
		return Invoice{}, err
	}
	included, err := workspaceTaxIncluded(ctx, ex, req.TenantID)
	if err != nil {
		return Invoice{}, err
	}
	// No user here: the workspace's default company's invoice sequence.
	var companyID uuid.UUID
	err = ex.QueryRow(ctx, `SELECT id FROM company WHERE tenant_id = $1 AND deleted_at IS NULL
		ORDER BY is_default DESC, created_at LIMIT 1`, req.TenantID).Scan(&companyID)
	if err != nil && !errors.Is(err, orm.ErrNotFound) {
		return Invoice{}, err
	}
	now := time.Now()
	number, err := nextNumber(ctx, ex, req.TenantID, companyID, sequenceInvoice, now)
	if err != nil {
		return Invoice{}, err
	}
	price := resolveUnitPrice(product, variant)
	if req.UnitPrice != nil {
		price = *req.UnitPrice
	}
	// Same taxes as an invoice line typed in the form: the product's (linked
	// below) plus the variant's own rate.
	taxes, err := productTaxes(ctx, orm.MustRepo[ProductTax](ex), orm.MustRepo[SaleTax](ex), req.TenantID, product.ID)
	if err != nil {
		return Invoice{}, err
	}
	rate := variantRate(variant)
	subtotal, total := computeLineTotal(req.Quantity*price, rate, taxes, included)
	tax := total - subtotal
	inv := Invoice{Number: number, IssueDate: &now, Subject: req.Subject, CustomerID: req.CustomerID,
		CustomerName: req.CustomerName, CustomerEmail: req.CustomerEmail, Status: "sent",
		Subtotal: &subtotal, TaxAmount: &tax, Total: &total,
		TenantID: req.TenantID}
	if inv, err = orm.MustRepo[Invoice](ex).Create(ctx, inv); err != nil {
		return Invoice{}, fmt.Errorf("sale: create invoice: %w", err)
	}
	line := SaleLine{InvoiceID: inv.ID, VariantID: req.VariantID, VariantName: name, Quantity: req.Quantity,
		TaxRate: rate, UnitPrice: price, Subtotal: subtotal, Total: total,
		TenantID: req.TenantID}
	created, err := orm.MustRepo[SaleLine](ex).Create(ctx, line)
	if err != nil {
		return Invoice{}, fmt.Errorf("sale: create invoice line: %w", err)
	}
	if err := linkLineTaxes(ctx, orm.MustRepo[SaleLineTax](ex), req.TenantID, created.ID, taxes); err != nil {
		return Invoice{}, err
	}
	return inv, nil
}

// SetInvoiceStatus moves an invoice to status unless it is already in one of
// keep (e.g. never cancel a paid invoice). Reports whether it changed.
func SetInvoiceStatus(ctx context.Context, ex orm.Executor, tenant, id uuid.UUID, status string, keep ...string) (bool, error) {
	tag, err := ex.Exec(ctx, `UPDATE invoice SET status = $3, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND status <> ALL($4)`, id, tenant, status, append(keep, status))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// PriceDisplay converts a unit price (as stored: excl. tax unless the workspace
// prices tax-included) into what a customer pays per unit, tax included.
type PriceDisplay func(unit float64) float64

// VariantPricing returns variantID's own unit price and the function turning
// any unit price on it (the variant's, or an override) into a tax-included
// amount for display.
func VariantPricing(ctx context.Context, ex orm.Executor, tenant, variantID uuid.UUID) (float64, PriceDisplay, error) {
	_, product, variant, err := loadVariant(ctx, ex, tenant, variantID)
	if err != nil {
		return 0, nil, err
	}
	included, err := workspaceTaxIncluded(ctx, ex, tenant)
	if err != nil {
		return 0, nil, err
	}
	taxes, err := productTaxes(ctx, orm.MustRepo[ProductTax](ex), orm.MustRepo[SaleTax](ex), tenant, product.ID)
	if err != nil {
		return 0, nil, err
	}
	rate := variantRate(variant)
	return resolveUnitPrice(product, variant), func(unit float64) float64 {
		_, total := computeLineTotal(unit, rate, taxes, included)
		return total
	}, nil
}
