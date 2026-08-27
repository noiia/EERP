// Package company owns the multi-company feature: one tenant may host several
// Companies (legal entities); a user has one "active" Company at a time
// (switchable, a per-user preference like PreferredLocale — see
// internal/auth's Users.ActiveCompanyID), and every workspace setting
// (internal/settings) is scoped per-Company rather than per-tenant.
package company

import (
	"core/orm/model"

	"github.com/google/uuid"
)

// Company is a legal entity within a tenant — the "who are we" profile other
// features (e.g. sale.invoice's printed letterhead) read from instead of
// re-entering the same name/address/phone/email repeatedly.
type Company struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id,index"`
	Name     string    `db:"name"`
	// Address* — the type: 'address' composite field's 7 sibling columns
	// (core-front's AddressWidget, core/CLAUDE.md's ORM section), prefixed
	// "address_" to match the frontend field name 'address'. Real columns
	// rather than a JSON blob so they stay filterable/searchable through the
	// generic list endpoint like any other column.
	AddressNumber     *int   `db:"address_number"`
	AddressComplement string `db:"address_complement"`
	AddressStreet     string `db:"address_street"`
	AddressZipCode    string `db:"address_zip_code"`
	AddressCity       string `db:"address_city"`
	AddressState      string `db:"address_state"`
	AddressCountry    string `db:"address_country"`
	Phone             string `db:"phone"`
	Email             string `db:"email"`
	// Currency is this company's own global currency (e.g. "USD") — the
	// single source of truth sale.Invoice/sale.Quote used to duplicate as a
	// per-document field. A document's currency is now implicit: whichever
	// company issued it.
	Currency string `db:"currency"`
	// IsDefault marks the lazily-bootstrapped company a tenant with none gets
	// on first touch (repository.go's ensureDefaultCompany) — at most one per
	// tenant, enforced by module.go's partial unique index, which is also
	// the ON CONFLICT arbiter that makes bootstrap race-safe under concurrent
	// requests.
	IsDefault bool `db:"is_default"`
	// Logo is the flag column behind the company form's boolean/picture
	// widget (apps/shell/app/settings/company/descriptors.ts): true ⇔ a
	// picture row exists on the (company, record, logo) anchor — same shape
	// as core/modules/crm's own Picture column; the picture service owns the
	// bytes. Pointer = nullable, so a company created before this field
	// existed (or via the generic API with no logo) stays a valid row.
	Logo *bool `db:"logo"`
}
