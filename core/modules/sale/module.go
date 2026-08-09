package sale

import (
	"time"

	"core/internal/module"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func init() {
	module.RegisterGoModule(&saleModule{})
}

// Invoice is a billing document issued to a customer — the sale module's
// dashboard has a single section, Invoice, over this entity. The table name
// derives from the struct name: "invoice" (GET /api/v1/invoice). Field
// layout mirrors a standard French "devis"/invoice template end to end
// (docs/adr/ADR-011, views/SaleViews.ts's sale.invoice report): logo,
// issuer, client, line items, HT/TVA/TTC totals, payment terms.
type Invoice struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	// Logo backs the boolean/picture widget in the form's top-left corner —
	// same flag-column contract as crm.CRM's Picture (true ⇔ a picture exists
	// on the (invoice, record, logo) anchor; the picture service owns the
	// bytes). The print route resolves it to a data: URL before rendering
	// (docs/adr/ADR-011) — ReportRenderer never talks to the picture service.
	Logo *bool `db:"logo"`
	// Issuer* is the seller's own letterhead block — a snapshot on the
	// invoice, not a live join to a workspace-wide "company profile" (no
	// such concept exists yet in this codebase; app_settings would be the
	// natural home for one once multiple invoices need to share a single
	// issuer identity without re-entering it).
	IssuerName    string `db:"issuer_name"`
	IssuerAddress string `db:"issuer_address"`
	IssuerPhone   string `db:"issuer_phone"`
	IssuerEmail   string `db:"issuer_email"`
	// Number is the human-facing invoice reference (e.g. "INV-2026-0001"),
	// distinct from the record's own UUID id.
	Number    string     `db:"number"`
	IssueDate *time.Time `db:"issue_date"`
	// Subject is the invoice's one-line "Objet" — what the invoice is for.
	Subject string `db:"subject"`
	// CustomerID is the optional many2one FK behind the form's contact search
	// widget (nullable, same contract as crm.CRM's Contacts).
	CustomerID *uuid.UUID `db:"customer_id"`
	// CustomerName/CustomerEmail/CustomerAddress are the bill-to snapshot
	// printed on the PDF — captured at invoice time on purpose, not resolved
	// live through CustomerID: an invoice must keep reading correctly even if
	// the linked contact is later renamed or moved (and the report layout,
	// like crm.statement, only ever reads scalar fields already on the
	// record — no FK join at print time).
	CustomerName    string     `db:"customer_name"`
	CustomerEmail   string     `db:"customer_email"`
	CustomerAddress string     `db:"customer_address"`
	DueDate         *time.Time `db:"due_date"`
	Status          string     `db:"status"` // "draft", "sent", "paid", "overdue", "cancelled"
	Currency        string     `db:"currency"`
	Reference       string     `db:"reference"` // customer PO / reference number
	// Subtotal/Discount/NetSubtotal/TaxAmount/Total are the invoice's HT ->
	// TVA -> TTC breakdown, each a REAL stored column rather than a
	// compute:store:false field — the print pipeline reads the raw record,
	// never the client compute registry, so a value it must show has to
	// actually be a column. Unlike before (a single manually-typed
	// TaxRate), TaxAmount is now a ROLLUP over this invoice's SaleLine rows
	// — "the tax amount, depending on each product's own tax and price" —
	// recomputed server-side by sale_line's Create/Update/Delete overrides
	// (see handler.go's recomputeTotals) every time a line changes, not by
	// a frontend on_change: only the backend sees every sibling line.
	// NetSubtotal = Subtotal - Discount; Total = NetSubtotal + TaxAmount.
	Subtotal      *float64 `db:"subtotal"`
	Discount      *float64 `db:"discount"`
	NetSubtotal   *float64 `db:"net_subtotal"`
	TaxAmount     *float64 `db:"tax_amount"`
	Total         *float64 `db:"total"`
	PaymentMethod string   `db:"payment_method"`
	PaymentTerms  string   `db:"payment_terms"`
	// LegalNotice is free text on purpose, not hardcoded boilerplate: the
	// mandatory-late-payment-notice wording a real business must print is
	// jurisdiction-specific (e.g. France's Loi n°92-1442), so baking one
	// country's legal text into the module would be wrong everywhere else.
	LegalNotice string `db:"legal_notice"`
}

// SaleLine is one row of an invoice's item table — the "table style
// display" the invoice form and PDF report both render (see
// views/SaleViews.ts, invoiceReport's 'lines' table). It replaces the old
// Invoice.Lines JSONB blob with a real table so a line can point at an
// actual product.
//
// VariantID (not ProductID) is the line's first/real column — a sale line
// is always struck against a specific warehouse.ProductVariant, never a
// bare warehouse.Product directly (see warehouse/module.go's doc comment on
// ProductVariant for why: a variant is what "automatically" gets created
// off a product the first time it's needed, and then stays around to be
// reused). Unit/TaxRate/UnitPrice are SNAPSHOTS copied from the variant's
// underlying Product at line-creation time (handler.go's Create override)
// — same "capture at document time, don't live-join" contract as
// Invoice.CustomerName: a line must keep reading correctly even if the
// product's price changes later, and the PDF report reads raw columns,
// never a live join.
type SaleLine struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"`
	// InvoiceID is the parent FK — the one2many inverse field the invoice
	// form's line-items table filters on (views/SaleViews.ts).
	InvoiceID uuid.UUID `db:"invoice_id"`
	// VariantID many2one -> warehouse.ProductVariant. First column per the
	// request ("first column is product.variant many2one").
	VariantID uuid.UUID `db:"variant_id"`
	// VariantName is a display-only snapshot of the variant's own Name,
	// same "don't live-join" reasoning as the other snapshots — it exists so
	// the invoice form's embedded line-items table (a read-only grid over
	// raw JSON rows, see views/SaleViews.ts) can show a product name instead
	// of a bare variant_id uuid.
	VariantName string  `db:"variant_name"`
	Quantity    float64 `db:"quantity"`
	// Unit/TaxRate/UnitPrice: snapshotted from the variant's Product on
	// create (see handler.go). TaxRate is a 0..1 ratio; UnitPrice is
	// "free taxes" (excl. tax), matching warehouse.Product's own fields.
	Unit      string  `db:"unit"`
	TaxRate   float64 `db:"tax_rate"`
	UnitPrice float64 `db:"unit_price"`
}

type saleModule struct{}

func (m *saleModule) Name() string { return "sale" }

func (m *saleModule) Register() error {
	if err := orm.Register[Invoice](); err != nil {
		return err
	}
	return orm.Register[SaleLine]()
}
