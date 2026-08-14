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
	Address  string    `db:"address"`
	Phone    string    `db:"phone"`
	Email    string    `db:"email"`
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
}
