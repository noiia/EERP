package sale

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"core/internal/auth"
	"core/internal/company"
	"core/internal/settings"
	"core/internal/testdb"
	_ "core/modules/auth"
	_ "core/modules/company"
	_ "core/modules/contact"
	_ "core/modules/mail"
	_ "core/modules/settings"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

type fakePDFs struct {
	pdf   []byte
	err   error
	calls []string
}

func (f *fakePDFs) Render(_ context.Context, _ auth.Identity, name, id string) ([]byte, error) {
	f.calls = append(f.calls, name+"/"+id)
	return f.pdf, f.err
}

type workflowFixture struct {
	db       *orm.DB
	h        *WorkflowHandler
	pdfs     *fakePDFs
	identity auth.Identity
}

func newWorkflowFixture(t *testing.T) workflowFixture {
	t.Helper()
	ctx := context.Background()
	app := testdb.Open(t)
	testdb.MigrateModules(t, app, "auth", "company", "settings", "contact", "mail", "warehouse", "sale")
	tenant, user := uuid.New(), uuid.New()
	t.Cleanup(func() {
		for _, table := range []string{
			"quote_recipient", "invoice_recipient", "sale_line", "quote_line", "invoice", "quote",
			"sale_sequence", "contact", "mail_outbox", "app_settings", "company", "users",
		} {
			_, _ = app.DB.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id = $1`, tenant)
		}
	})
	if _, err := app.DB.Exec(ctx, `INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, $3)`,
		user, tenant, user.String()+"@sale.test"); err != nil {
		t.Fatal(err)
	}
	pdfs := &fakePDFs{pdf: []byte("%PDF-fake")}
	return workflowFixture{
		db:       app.DB,
		h:        NewWorkflowHandler(app.DB, company.NewRepository(app.DB), settings.NewRepository(app.DB), pdfs),
		pdfs:     pdfs,
		identity: auth.Identity{TenantID: tenant, UserID: user},
	}
}

func (f workflowFixture) quote(t *testing.T, status, customerEmail string, customerID *uuid.UUID, lines int) Quote {
	t.Helper()
	ctx := context.Background()
	total := 42.0
	q, err := orm.MustRepo[Quote](f.db).Create(ctx, Quote{
		BaseModel: model.BaseModel{TenantID: f.identity.TenantID}, Number: "Q-TEST", Status: status,
		Subject: "Desk", CustomerName: "Ada", CustomerEmail: customerEmail, CustomerID: customerID, Total: &total,
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < lines; i++ {
		if _, err := orm.MustRepo[QuoteLine](f.db).Create(ctx, QuoteLine{
			BaseModel: model.BaseModel{TenantID: f.identity.TenantID}, QuoteID: q.ID, VariantID: uuid.New(),
			VariantName: "Oak desk", Quantity: 2, UnitPrice: 100, TaxRate: 0.2,
		}); err != nil {
			t.Fatal(err)
		}
	}
	return q
}

func (f workflowFixture) contact(t *testing.T, name, email string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.db.QueryRow(context.Background(), `INSERT INTO contact (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
		f.identity.TenantID, name, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f workflowFixture) recipient(t *testing.T, quote, contact uuid.UUID) {
	t.Helper()
	if _, err := f.db.Exec(context.Background(), `INSERT INTO quote_recipient (tenant_id, quote_id, contact_id) VALUES ($1, $2, $3)`,
		f.identity.TenantID, quote, contact); err != nil {
		t.Fatal(err)
	}
}

type outboxRow struct {
	To          string
	Subject     string
	Attachments string
}

func (f workflowFixture) outbox(t *testing.T) []outboxRow {
	t.Helper()
	rows, err := f.db.Query(context.Background(),
		`SELECT to_address, subject, COALESCE(attachments, '') FROM mail_outbox WHERE tenant_id = $1 ORDER BY to_address`, f.identity.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.To, &r.Subject, &r.Attachments); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func (f workflowFixture) status(t *testing.T, id uuid.UUID) string {
	t.Helper()
	s, err := status(context.Background(), f.db, quoteKind, f.identity.TenantID, id)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestNextNumber(t *testing.T) {
	f := newWorkflowFixture(t)
	ctx := context.Background()
	tenant := f.identity.TenantID
	coA, coB := uuid.New(), uuid.New()
	jan := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	next := func(co uuid.UUID, kind string, at time.Time) string {
		t.Helper()
		n, err := nextNumber(ctx, f.db, tenant, co, kind, at)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}

	// A number typed before sequences existed is never handed out again.
	if _, err := f.db.Exec(ctx, `INSERT INTO invoice (tenant_id, number, status) VALUES ($1, 'INV-2026-0041', 'draft')`, tenant); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		got  string
		want string
	}{
		{"first quote of the year", next(coA, sequenceQuote, jan), "Q-2026-0001"},
		{"the next one", next(coA, sequenceQuote, jan), "Q-2026-0002"},
		{"another company has its own sequence", next(coB, sequenceQuote, jan), "Q-2026-0001"},
		{"invoices start after the typed one", next(coA, sequenceInvoice, jan), "INV-2026-0042"},
		{"a new year restarts", next(coA, sequenceQuote, jan.AddDate(1, 0, 0)), "Q-2027-0001"},
		{"and keeps counting", next(coA, sequenceQuote, jan.AddDate(1, 0, 0)), "Q-2027-0002"},
	}
	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, tt.got, tt.want)
		}
	}
	if got := next(coB, sequenceQuote, jan); got != "Q-2026-0002" {
		t.Errorf("company B's second quote = %q, want Q-2026-0002", got)
	}
	if got := next(coA, sequenceQuote, jan); got != "Q-2026-0003" {
		t.Errorf("company A's third quote = %q, want Q-2026-0003", got)
	}
	if _, err := nextNumber(ctx, f.db, tenant, coA, "order", jan); err == nil {
		t.Error("an unknown sequence kind must fail")
	}
}

func TestSendQuote_EmailsCustomerAndRecipientsWithThePDF(t *testing.T) {
	f := newWorkflowFixture(t)
	customer := f.contact(t, "Ada", "ada@example.test")
	q := f.quote(t, "confirmed", "", &customer, 1)
	f.recipient(t, q.ID, f.contact(t, "Bob", "bob@example.test"))
	f.recipient(t, q.ID, f.contact(t, "Ada again", "ADA@example.test")) // same address as the customer
	f.recipient(t, q.ID, f.contact(t, "No mail", ""))

	rec := serveAs(t, f.h.SendQuote, http.MethodPost, "", f.identity, q.ID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("send = %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Record map[string]any `json:"record"`
		SentTo []string       `json:"sent_to"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	if resp.Record["status"] != "sent" || len(resp.SentTo) != 2 || resp.SentTo[0] != "ada@example.test" || resp.SentTo[1] != "bob@example.test" {
		t.Errorf("send answered %+v", resp)
	}
	if len(f.pdfs.calls) != 1 || f.pdfs.calls[0] != "sale.quote/"+q.ID.String() {
		t.Errorf("rendered %v, want the quote report once", f.pdfs.calls)
	}
	mails := f.outbox(t)
	if len(mails) != 2 {
		t.Fatalf("outbox = %+v, want one mail per recipient", mails)
	}
	for _, m := range mails {
		if m.Subject != "Quote Q-TEST from "+companyName(t, f) {
			t.Errorf("subject = %q", m.Subject)
		}
		var att []map[string]any
		must(t, json.Unmarshal([]byte(m.Attachments), &att))
		if len(att) != 1 || att[0]["filename"] != "Q-TEST.pdf" {
			t.Errorf("attachments = %s, want Q-TEST.pdf", m.Attachments)
		}
	}
}

func companyName(t *testing.T, f workflowFixture) string {
	t.Helper()
	co, err := company.NewRepository(f.db).ResolveActive(context.Background(), f.identity.TenantID, f.identity.UserID)
	if err != nil {
		t.Fatal(err)
	}
	return co.Name
}

func TestSendQuote_Refusals(t *testing.T) {
	f := newWorkflowFixture(t)

	t.Run("a failed render sends nothing and keeps the status", func(t *testing.T) {
		q := f.quote(t, "confirmed", "ada@example.test", nil, 1)
		f.pdfs.err = errors.New("pdf-service down")
		defer func() { f.pdfs.err = nil }()
		if rec := serveAs(t, f.h.SendQuote, http.MethodPost, "", f.identity, q.ID.String()); rec.Code != http.StatusBadGateway {
			t.Fatalf("send = %d, want 502", rec.Code)
		}
		if got := f.status(t, q.ID); got != "confirmed" {
			t.Errorf("status = %q, want confirmed", got)
		}
		if mails := f.outbox(t); len(mails) != 0 {
			t.Errorf("mails queued despite the failure: %+v", mails)
		}
	})

	t.Run("nobody to send to", func(t *testing.T) {
		q := f.quote(t, "confirmed", "", nil, 1)
		if rec := serveAs(t, f.h.SendQuote, http.MethodPost, "", f.identity, q.ID.String()); rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("send = %d, want 422", rec.Code)
		}
	})

	t.Run("another tenant's quote is not found", func(t *testing.T) {
		q := f.quote(t, "confirmed", "ada@example.test", nil, 1)
		them := auth.Identity{TenantID: uuid.New(), UserID: f.identity.UserID}
		for name, h := range map[string]func() int{
			"send":    func() int { return serveAs(t, f.h.SendQuote, http.MethodPost, "", them, q.ID.String()).Code },
			"confirm": func() int { return serveAs(t, f.h.ConfirmQuote, http.MethodPost, "", them, q.ID.String()).Code },
			"accept":  func() int { return serveAs(t, f.h.AcceptQuote, http.MethodPost, "", them, q.ID.String()).Code },
		} {
			if code := h(); code != http.StatusNotFound {
				t.Errorf("%s from another tenant = %d, want 404", name, code)
			}
		}
	})
}

func TestAcceptQuote_ConvertsAtQuotedPrices(t *testing.T) {
	f := newWorkflowFixture(t)
	ctx := context.Background()
	customer := f.contact(t, "Ada", "ada@example.test")
	q := f.quote(t, "sent", "ada@example.test", &customer, 2)
	f.recipient(t, q.ID, f.contact(t, "Bob", "bob@example.test"))

	rec := serveAs(t, f.h.AcceptQuote, http.MethodPost, "", f.identity, q.ID.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Record    map[string]any `json:"record"`
		InvoiceID uuid.UUID      `json:"invoice_id"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	if resp.Record["status"] != "accepted" {
		t.Errorf("quote status = %v, want accepted", resp.Record["status"])
	}
	inv, err := findOwned(ctx, orm.MustRepo[Invoice](f.db), resp.InvoiceID, f.identity.TenantID)
	must(t, err)
	if inv.Status != "draft" || inv.QuoteID == nil || *inv.QuoteID != q.ID || inv.CustomerName != "Ada" || len(inv.Number) == 0 || inv.Number[:4] != "INV-" {
		t.Errorf("invoice = %+v", inv)
	}
	lines, err := orm.MustRepo[SaleLine](f.db).FindAll(ctx, orm.Cond("invoice_id = $1", inv.ID))
	must(t, err)
	if len(lines) != 2 || lines[0].UnitPrice != 100 || lines[0].Quantity != 2 {
		t.Errorf("invoice lines = %+v, want the quote's 2 lines at 2 × 100", lines)
	}
	// 2 lines of 2 × 100 + 20%: 400 excl. tax, 480 incl.
	if inv.Subtotal == nil || *inv.Subtotal != 400 || inv.Total == nil || *inv.Total != 480 {
		t.Errorf("invoice totals = %v / %v, want 400 / 480", inv.Subtotal, inv.Total)
	}
	var recipients int
	must(t, f.db.QueryRow(ctx, `SELECT count(*) FROM invoice_recipient WHERE invoice_id = $1`, inv.ID).Scan(&recipients))
	if recipients != 1 {
		t.Errorf("invoice recipients = %d, want the quote's 1", recipients)
	}
	// Accepting twice is refused.
	if rec := serveAs(t, f.h.AcceptQuote, http.MethodPost, "", f.identity, q.ID.String()); rec.Code != http.StatusConflict {
		t.Errorf("second accept = %d, want 409", rec.Code)
	}
}
