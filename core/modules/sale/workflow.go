package sale

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"strings"
	"time"

	"core/internal/auth"
	"core/internal/company"
	eerpmail "core/internal/mail"
	"core/internal/settings"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// The quote and invoice workflows, server-side so each step is checked and
// atomic (the header buttons in quote_views.ts/invoice_views.ts call these):
//
//	quote:   draft -> confirmed -> sent -> accepted (raises the invoice) | declined
//	invoice: draft -> confirmed -> sent -> paid
//
// POST /api/v1/{quote|invoice}/:id/{confirm|send}, POST /api/v1/quote/:id/accept
// — permission <table>:<table>:write, route-derived. Each answers
// {"record": <the document>} (plus "invoice_id" for accept).
//
// Confirm needs at least one line; Send emails the document's PDF to its
// Customer and every Recipient (mail outbox, same transaction as the status
// change); Accept converts the quote into a draft invoice — its own number,
// the quote's lines at their QUOTED prices, its recipients — linked back by
// invoice.quote_id. The line rule holds for plain edits too (GuardBody): a
// document with no line stays a draft.

// Mail templates (ADR-027) sent by Send.
const (
	TemplateQuoteSent   = "sale.quote_sent"
	TemplateInvoiceSent = "sale.invoice_sent"
)

var documentVars = []string{"name", "number", "subject", "total", "company"}

// A quote has no subject (its form doesn't show one), so its template doesn't
// offer the variable.
var quoteVars = []string{"name", "number", "total", "company"}

func init() {
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateQuoteSent, Label: "Quote sent to a customer", Vars: quoteVars,
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "Quote {{number}} from {{company}}", HTML: `<p>Hello {{name}},</p>` +
				`<p>Please find attached our quote {{number}}.</p><p>Total: {{total}}</p>` +
				`<p>Best regards,<br>{{company}}</p>`},
			"fr": {Subject: "Devis {{number}} de {{company}}", HTML: `<p>Bonjour {{name}},</p>` +
				`<p>Veuillez trouver ci-joint notre devis {{number}}.</p><p>Total : {{total}}</p>` +
				`<p>Cordialement,<br>{{company}}</p>`},
		},
	})
	eerpmail.RegisterTemplate(eerpmail.TemplateDef{
		Key: TemplateInvoiceSent, Label: "Invoice sent to a customer", Vars: documentVars,
		Defaults: map[string]eerpmail.Content{
			"en": {Subject: "Invoice {{number}} from {{company}}", HTML: `<p>Hello {{name}},</p>` +
				`<p>Please find attached our invoice {{number}}: {{subject}}.</p><p>Total: {{total}}</p>` +
				`<p>Best regards,<br>{{company}}</p>`},
			"fr": {Subject: "Facture {{number}} de {{company}}", HTML: `<p>Bonjour {{name}},</p>` +
				`<p>Veuillez trouver ci-jointe notre facture {{number}} : {{subject}}.</p><p>Total : {{total}}</p>` +
				`<p>Cordialement,<br>{{company}}</p>`},
		},
	})
}

// PDFSource renders a record's report to PDF as a user —
// *reports.Handler satisfies it. Nil when report generation isn't
// configured: Send then emails without the attachment.
type PDFSource interface {
	Render(ctx context.Context, identity auth.Identity, name, recordID string) ([]byte, error)
}

// docKind describes one document type for the shared workflow code.
type docKind struct {
	kind           string // sequence kind
	table          string
	lineTable      string
	lineFK         string
	recipientTable string
	recipientFK    string
	report         string
	template       string
	label          string // "quote" / "invoice", for messages
	// needsLines: the statuses a document can only hold with at least one line.
	needsLines map[string]bool
}

var (
	quoteKind = docKind{
		kind: sequenceQuote, table: "quote", lineTable: "quote_line", lineFK: "quote_id",
		recipientTable: "quote_recipient", recipientFK: "quote_id",
		report: "sale.quote", template: TemplateQuoteSent, label: "quote",
		needsLines: map[string]bool{"confirmed": true, "sent": true, "accepted": true},
	}
	invoiceKind = docKind{
		kind: sequenceInvoice, table: "invoice", lineTable: "sale_line", lineFK: "invoice_id",
		recipientTable: "invoice_recipient", recipientFK: "invoice_id",
		report: "sale.invoice", template: TemplateInvoiceSent, label: "invoice",
		needsLines: map[string]bool{"confirmed": true, "sent": true, "paid": true, "overdue": true},
	}
)

// WorkflowHandler serves the workflow routes and the numbering/guard
// middlewares in front of the generic quote/invoice writes.
type WorkflowHandler struct {
	db            *orm.DB
	companies     *company.Repository
	settingsStore *settings.Repository
	pdfs          PDFSource
	quotes        *orm.Repository[Quote]
	invoices      *orm.Repository[Invoice]
}

func NewWorkflowHandler(db *orm.DB, companies *company.Repository, settingsStore *settings.Repository, pdfs PDFSource) *WorkflowHandler {
	return &WorkflowHandler{
		db: db, companies: companies, settingsStore: settingsStore, pdfs: pdfs,
		quotes: orm.MustRepo[Quote](db), invoices: orm.MustRepo[Invoice](db),
	}
}

// workflowError is a refusal with its HTTP status and code.
type workflowError struct {
	status int
	code   string
	msg    string
}

func (e *workflowError) Error() string { return e.msg }

func refuse(status int, code, msg string) error { return &workflowError{status, code, msg} }

// reply turns a workflow error into its envelope; any other error propagates.
func reply(c *echo.Context, err error) error {
	if we, ok := errors.AsType[*workflowError](err); ok {
		return errorJSON(c, we.status, we.code, we.msg)
	}
	return err
}

func pathID(c *echo.Context) (uuid.UUID, error) {
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return uuid.Nil, refuse(http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}
	return id, nil
}

// status reads a document's status within the tenant; 404 when absent.
func status(ctx context.Context, ex orm.Executor, k docKind, tenant, id uuid.UUID) (string, error) {
	var s string
	// #nosec G201 — table names come from docKind constants.
	err := ex.QueryRow(ctx, fmt.Sprintf(`SELECT status FROM %s WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, k.table), id, tenant).Scan(&s)
	if errors.Is(err, orm.ErrNotFound) {
		return "", refuse(http.StatusNotFound, "NOT_FOUND", "The "+k.label+" was not found.")
	}
	return s, err
}

func lineCount(ctx context.Context, ex orm.Executor, k docKind, tenant, id uuid.UUID) (int, error) {
	var n int
	// #nosec G201 — table/column names come from docKind constants.
	err := ex.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s = $1 AND tenant_id = $2 AND deleted_at IS NULL`, k.lineTable, k.lineFK), id, tenant).Scan(&n)
	return n, err
}

func noLines(k docKind) error {
	return refuse(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Add at least one line before confirming the "+k.label+".")
}

// move sets the status from one value to another, failing if the document
// is no longer in `from` (a concurrent click).
func move(ctx context.Context, ex orm.Executor, k docKind, tenant, id uuid.UUID, from, to string) error {
	// #nosec G201 — table names come from docKind constants.
	tag, err := ex.Exec(ctx, fmt.Sprintf(`UPDATE %s SET status = $4, updated_at = now()
		WHERE id = $1 AND tenant_id = $2 AND status = $3 AND deleted_at IS NULL`, k.table), id, tenant, from, to)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return refuse(http.StatusConflict, "CONFLICT", "The "+k.label+" changed meanwhile; reload it.")
	}
	return nil
}

// requireStatus refuses unless the document is in `want`.
func requireStatus(ctx context.Context, ex orm.Executor, k docKind, tenant, id uuid.UUID, want, action string) error {
	s, err := status(ctx, ex, k, tenant, id)
	if err != nil {
		return err
	}
	if s != want {
		return refuse(http.StatusConflict, "CONFLICT", fmt.Sprintf("Only a %s %s can be %s.", want, k.label, action))
	}
	return nil
}

func (h *WorkflowHandler) record(ctx context.Context, k docKind, tenant, id uuid.UUID) (map[string]any, error) {
	if k.table == "quote" {
		q, err := findOwned(ctx, h.quotes, id, tenant)
		if err != nil {
			return nil, err
		}
		return toColumnMap(h.quotes, q), nil
	}
	inv, err := findOwned(ctx, h.invoices, id, tenant)
	if err != nil {
		return nil, err
	}
	return toColumnMap(h.invoices, inv), nil
}

func (h *WorkflowHandler) answer(c *echo.Context, k docKind, tenant, id uuid.UUID, extra map[string]any) error {
	rec, err := h.record(c.Request().Context(), k, tenant, id)
	if err != nil {
		return err
	}
	out := map[string]any{"record": rec}
	maps.Copy(out, extra)
	return c.JSON(http.StatusOK, out)
}

// ── Confirm ──────────────────────────────────────────────────────────────────

func (h *WorkflowHandler) confirm(c *echo.Context, k docKind) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)
	id, err := pathID(c)
	if err != nil {
		return reply(c, err)
	}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		if err := requireStatus(ctx, tx, k, identity.TenantID, id, "draft", "confirmed"); err != nil {
			return err
		}
		n, err := lineCount(ctx, tx, k, identity.TenantID, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return noLines(k)
		}
		return move(ctx, tx, k, identity.TenantID, id, "draft", "confirmed")
	})
	if err != nil {
		return reply(c, err)
	}
	return h.answer(c, k, identity.TenantID, id, nil)
}

// ConfirmQuote handles POST /api/v1/quote/:id/confirm.
func (h *WorkflowHandler) ConfirmQuote(c *echo.Context) error { return h.confirm(c, quoteKind) }

// ConfirmInvoice handles POST /api/v1/invoice/:id/confirm.
func (h *WorkflowHandler) ConfirmInvoice(c *echo.Context) error { return h.confirm(c, invoiceKind) }

// ── Send ─────────────────────────────────────────────────────────────────────

type recipient struct{ name, email string }

// recipients are the document's Customer (its customer_email, else the
// linked contact's email) then every Recipient contact, deduplicated by
// email, case-insensitively; contacts without an email are skipped.
func recipients(ctx context.Context, ex orm.Executor, k docKind, tenant, id uuid.UUID) ([]recipient, error) {
	var out []recipient
	seen := map[string]bool{}
	add := func(name, email string) {
		email = strings.TrimSpace(email)
		key := strings.ToLower(email)
		if email == "" || seen[key] {
			return
		}
		seen[key] = true
		out = append(out, recipient{name: strings.TrimSpace(name), email: email})
	}

	var name, email string
	// #nosec G201 — table names come from docKind constants.
	err := ex.QueryRow(ctx, fmt.Sprintf(`
		SELECT d.customer_name, COALESCE(NULLIF(d.customer_email, ''), c.email, '')
		  FROM %s d LEFT JOIN contact c ON c.id = d.customer_id AND c.tenant_id = d.tenant_id AND c.deleted_at IS NULL
		 WHERE d.id = $1 AND d.tenant_id = $2`, k.table), id, tenant).Scan(&name, &email)
	if err != nil {
		return nil, err
	}
	add(name, email)

	// #nosec G201 — table/column names come from docKind constants.
	rows, err := ex.Query(ctx, fmt.Sprintf(`
		SELECT c.name, c.email FROM %s r
		  JOIN contact c ON c.id = r.contact_id AND c.tenant_id = r.tenant_id AND c.deleted_at IS NULL
		 WHERE r.%s = $1 AND r.tenant_id = $2 AND r.deleted_at IS NULL
		 ORDER BY r.created_at, r.id`, k.recipientTable, k.recipientFK), id, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var n, e string
		if err := rows.Scan(&n, &e); err != nil {
			return nil, err
		}
		add(n, e)
	}
	return out, rows.Err()
}

func (h *WorkflowHandler) send(c *echo.Context, k docKind) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)
	id, err := pathID(c)
	if err != nil {
		return reply(c, err)
	}
	if err := requireStatus(ctx, h.db, k, identity.TenantID, id, "confirmed", "sent"); err != nil {
		return reply(c, err)
	}
	to, err := recipients(ctx, h.db, k, identity.TenantID, id)
	if err != nil {
		return err
	}
	if len(to) == 0 {
		return reply(c, refuse(http.StatusUnprocessableEntity, "VALIDATION_ERROR",
			"Give the customer an email, or add a recipient, before sending the "+k.label+"."))
	}

	var number, subject string
	var total *float64
	// #nosec G201 — table names come from docKind constants.
	if err := h.db.QueryRow(ctx, fmt.Sprintf(`SELECT number, subject, total FROM %s WHERE id = $1 AND tenant_id = $2`, k.table),
		id, identity.TenantID).Scan(&number, &subject, &total); err != nil {
		return err
	}
	co, err := h.companies.ResolveActive(ctx, identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("sale: resolve active company: %w", err)
	}

	// Rendered before the transaction: it takes seconds and reads the
	// document back through the API.
	var attachments []eerpmail.Attachment
	if h.pdfs != nil {
		pdf, err := h.pdfs.Render(ctx, identity, k.report, id.String())
		if err != nil {
			return reply(c, refuse(http.StatusBadGateway, "RENDER_FAILED", "Could not generate the "+k.label+" PDF; nothing was sent."))
		}
		attachments = []eerpmail.Attachment{{Filename: number + ".pdf", ContentType: "application/pdf", Data: pdf}}
	}

	vars := map[string]string{"number": number, "subject": subject, "company": co.Name, "total": formatTotal(total, co.Currency)}
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		if err := move(ctx, tx, k, identity.TenantID, id, "confirmed", "sent"); err != nil {
			return err
		}
		locale, err := eerpmail.ResolveLocale(ctx, tx, identity.TenantID, nil)
		if err != nil {
			return err
		}
		for _, r := range to {
			vars["name"] = r.name
			msg, err := eerpmail.Render(ctx, tx, identity.TenantID, k.template, locale, vars)
			if err != nil {
				return err
			}
			msg.TenantID, msg.To, msg.Attachments = identity.TenantID, r.email, attachments
			if err := eerpmail.Enqueue(ctx, tx, msg); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return reply(c, err)
	}
	emails := make([]string, len(to))
	for i, r := range to {
		emails[i] = r.email
	}
	return h.answer(c, k, identity.TenantID, id, map[string]any{"sent_to": emails})
}

func formatTotal(total *float64, currency string) string {
	v := 0.0
	if total != nil {
		v = *total
	}
	return strings.TrimSpace(fmt.Sprintf("%.2f %s", v, currency))
}

// SendQuote handles POST /api/v1/quote/:id/send.
func (h *WorkflowHandler) SendQuote(c *echo.Context) error { return h.send(c, quoteKind) }

// SendInvoice handles POST /api/v1/invoice/:id/send.
func (h *WorkflowHandler) SendInvoice(c *echo.Context) error { return h.send(c, invoiceKind) }

// ── Accept ───────────────────────────────────────────────────────────────────

// AcceptQuote handles POST /api/v1/quote/:id/accept: the sent quote becomes
// accepted and is converted into a draft invoice, in one transaction.
func (h *WorkflowHandler) AcceptQuote(c *echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)
	id, err := pathID(c)
	if err != nil {
		return reply(c, err)
	}
	// Checked before anything else (a foreign or missing id is a 404), and
	// again inside the transaction against a concurrent click.
	if err := requireStatus(ctx, h.db, quoteKind, identity.TenantID, id, "sent", "accepted"); err != nil {
		return reply(c, err)
	}
	co, err := h.companies.ResolveActive(ctx, identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("sale: resolve active company: %w", err)
	}
	included, err := settings.ResolveTaxIncluded(ctx, h.settingsStore, h.companies, identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("sale: resolve tax mode: %w", err)
	}

	var invoiceID uuid.UUID
	err = orm.Transact(ctx, h.db, func(tx *orm.Tx) error {
		if err := requireStatus(ctx, tx, quoteKind, identity.TenantID, id, "sent", "accepted"); err != nil {
			return err
		}
		quote, err := findOwned(ctx, h.quotes.WithTx(tx), id, identity.TenantID)
		if err != nil {
			return err
		}
		lines, err := orm.MustRepo[QuoteLine](h.db).WithTx(tx).FindAll(ctx,
			orm.Cond("quote_id = $1 AND tenant_id = $2", id, identity.TenantID))
		if err != nil {
			return err
		}
		if len(lines) == 0 {
			return noLines(quoteKind)
		}
		invoiceID, err = convertQuote(ctx, tx, quote, lines, co.ID, included)
		if err != nil {
			return err
		}
		return move(ctx, tx, quoteKind, identity.TenantID, id, "sent", "accepted")
	})
	if err != nil {
		return reply(c, err)
	}
	return h.answer(c, quoteKind, identity.TenantID, id, map[string]any{"invoice_id": invoiceID})
}

// convertQuote inserts the quote's draft invoice: the invoice sequence's next
// number, today's issue date, the quote's parties and terms, its lines at the
// prices the customer accepted (not today's catalog prices), its recipients.
func convertQuote(ctx context.Context, tx *orm.Tx, q Quote, lines []QuoteLine, companyID uuid.UUID, taxIncluded bool) (uuid.UUID, error) {
	now := time.Now()
	number, err := nextNumber(ctx, tx, q.TenantID, companyID, sequenceInvoice, now)
	if err != nil {
		return uuid.Nil, err
	}
	quoteID := q.ID
	inv := Invoice{
		Logo: q.Logo, IssuerName: q.IssuerName,
		IssuerAddressNumber: q.IssuerAddressNumber, IssuerAddressComplement: q.IssuerAddressComplement,
		IssuerAddressStreet: q.IssuerAddressStreet, IssuerAddressZipCode: q.IssuerAddressZipCode,
		IssuerAddressCity: q.IssuerAddressCity, IssuerAddressState: q.IssuerAddressState,
		IssuerAddressCountry: q.IssuerAddressCountry, IssuerPhone: q.IssuerPhone, IssuerEmail: q.IssuerEmail,
		Number: number, IssueDate: &now, Subject: q.Subject,
		CustomerID: q.CustomerID, CustomerName: q.CustomerName, CustomerEmail: q.CustomerEmail,
		CustomerAddressNumber: q.CustomerAddressNumber, CustomerAddressComplement: q.CustomerAddressComplement,
		CustomerAddressStreet: q.CustomerAddressStreet, CustomerAddressZipCode: q.CustomerAddressZipCode,
		CustomerAddressCity: q.CustomerAddressCity, CustomerAddressState: q.CustomerAddressState,
		CustomerAddressCountry: q.CustomerAddressCountry,
		Status:                 "draft", QuoteID: &quoteID,
		PaymentMethod: q.PaymentMethod, PaymentTerms: q.PaymentTerms, LegalNotice: q.LegalNotice,

		TenantID: q.TenantID}

	saleLines := make([]SaleLine, len(lines))
	for i, l := range lines {
		sl := SaleLine{
			VariantID: l.VariantID, VariantName: l.VariantName, Quantity: l.Quantity,
			Unit: l.Unit, UomID: l.UomID, TaxRate: l.TaxRate, UnitPrice: l.UnitPrice,

			TenantID: q.TenantID}
		sl.Subtotal, sl.Total = computeLineTotal(l.Quantity*l.UnitPrice, l.TaxRate, nil, taxIncluded)
		saleLines[i] = sl
	}
	subtotal, taxAmount, total := sumLines(saleLines)
	inv.Subtotal, inv.TaxAmount, inv.Total = &subtotal, &taxAmount, &total

	created, err := orm.MustRepo[Invoice](tx).Create(ctx, inv)
	if err != nil {
		return uuid.Nil, fmt.Errorf("sale: create invoice from quote: %w", err)
	}
	lineRepo := orm.MustRepo[SaleLine](tx)
	for _, sl := range saleLines {
		sl.InvoiceID = created.ID
		if _, err := lineRepo.Create(ctx, sl); err != nil {
			return uuid.Nil, fmt.Errorf("sale: create invoice line from quote: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO invoice_recipient (tenant_id, invoice_id, contact_id)
		SELECT tenant_id, $3, contact_id FROM quote_recipient
		 WHERE quote_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, q.ID, q.TenantID, created.ID); err != nil {
		return uuid.Nil, fmt.Errorf("sale: copy recipients: %w", err)
	}
	return created.ID, nil
}

// ── Numbering and the line rule on the generic writes ────────────────────────

func readBody(c *echo.Context) (map[string]any, error) {
	raw, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return nil, refuse(http.StatusBadRequest, "VALIDATION_ERROR", "Unreadable request body.")
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return nil, refuse(http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	return body, nil
}

func writeBody(c *echo.Context, body map[string]any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	c.Request().Body = io.NopCloser(bytes.NewReader(raw))
	c.Request().ContentLength = int64(len(raw))
	return nil
}

// NumberQuote / NumberInvoice wrap the generic POST /api/v1/{quote|invoice}:
// the number is always the sequence's next one (whatever the body says) and
// a new document starts as a draft (no status, or one that needs lines it
// can't have yet).
func (h *WorkflowHandler) NumberQuote(next echo.HandlerFunc) echo.HandlerFunc {
	return h.numberOnCreate(quoteKind, next)
}

func (h *WorkflowHandler) NumberInvoice(next echo.HandlerFunc) echo.HandlerFunc {
	return h.numberOnCreate(invoiceKind, next)
}

func (h *WorkflowHandler) numberOnCreate(k docKind, next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		identity := auth.MustIdentity(ctx)
		body, err := readBody(c)
		if err != nil {
			return reply(c, err)
		}
		co, err := h.companies.ResolveActive(ctx, identity.TenantID, identity.UserID)
		if err != nil {
			return fmt.Errorf("sale: resolve active company: %w", err)
		}
		number, err := nextNumber(ctx, h.db, identity.TenantID, co.ID, k.kind, time.Now())
		if err != nil {
			return err
		}
		body["number"] = number
		// Text columns the form may not send (a quote's form has no subject
		// and only snapshots the customer's email): empty, never "required".
		for _, col := range []string{"subject", "customer_email"} {
			if v, ok := body[col]; !ok || v == nil {
				body[col] = ""
			}
		}
		if s, _ := body["status"].(string); s == "" || k.needsLines[s] {
			body["status"] = "draft"
		}
		if err := writeBody(c, body); err != nil {
			return err
		}
		return next(c)
	}
}

// GuardQuote / GuardInvoice wrap the generic PUT /api/v1/{quote|invoice}/:id:
// the number can't change, and a status that needs lines is refused while
// the document has none.
func (h *WorkflowHandler) GuardQuote(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guardOnUpdate(quoteKind, next)
}

func (h *WorkflowHandler) GuardInvoice(next echo.HandlerFunc) echo.HandlerFunc {
	return h.guardOnUpdate(invoiceKind, next)
}

func (h *WorkflowHandler) guardOnUpdate(k docKind, next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		identity := auth.MustIdentity(ctx)
		id, err := pathID(c)
		if err != nil {
			return reply(c, err)
		}
		body, err := readBody(c)
		if err != nil {
			return reply(c, err)
		}
		var number string
		// #nosec G201 — table names come from docKind constants.
		err = h.db.QueryRow(ctx, fmt.Sprintf(`SELECT number FROM %s WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, k.table),
			id, identity.TenantID).Scan(&number)
		if errors.Is(err, orm.ErrNotFound) {
			// The generic handler answers the 404 — with the body put back.
			if err := writeBody(c, body); err != nil {
				return err
			}
			return next(c)
		}
		if err != nil {
			return err
		}
		body["number"] = number
		// Text columns the form may not send (a quote's form has no subject
		// and only snapshots the customer's email): empty, never "required".
		for _, col := range []string{"subject", "customer_email"} {
			if v, ok := body[col]; !ok || v == nil {
				body[col] = ""
			}
		}
		if s, _ := body["status"].(string); k.needsLines[s] {
			n, err := lineCount(ctx, h.db, k, identity.TenantID, id)
			if err != nil {
				return err
			}
			if n == 0 {
				return reply(c, noLines(k))
			}
		}
		if err := writeBody(c, body); err != nil {
			return err
		}
		return next(c)
	}
}
