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
	// Lines is the item table (Description/Unit/Quantity/Unit price/VAT/Total),
	// stored as JSONB — the ORM has no editable-array form widget yet, so this
	// is real, printable data (populated via the generic PUT/POST API, or a
	// future editor) rather than a fake grid nobody can actually fill in.
	// Each row: {"description","unit","quantity","unit_price","vat_rate","total_ht"}.
	Lines *[]map[string]any `db:"lines"`
	// Subtotal/Discount/NetSubtotal/TaxRate/TaxAmount/Total are the invoice's
	// HT -> TVA -> TTC breakdown, each a REAL stored column rather than a
	// compute:store:false field — the print pipeline reads the raw record,
	// never the client compute registry, so a value it must show has to
	// actually be a column (see views/SaleViews.ts: sale.calcTotal, an
	// on_change that commits them the same way crm.scoreFromStatus commits
	// Score). NetSubtotal = Subtotal - Discount; TaxAmount = NetSubtotal *
	// TaxRate; Total = NetSubtotal + TaxAmount.
	Subtotal      *float64 `db:"subtotal"`
	Discount      *float64 `db:"discount"`
	NetSubtotal   *float64 `db:"net_subtotal"`
	TaxRate       *float64 `db:"tax_rate"` // 0..1 ratio, displayed ×100 by the percent widget
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

type saleModule struct{}

func (m *saleModule) Name() string { return "sale" }

func (m *saleModule) Register() error {
	return orm.Register[Invoice]()
}
