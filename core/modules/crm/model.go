package crm

import crminternal "core/modules/crm/internal"

// CRM re-exports the base entity from internal so that inheriting modules
// can embed it without violating Go's internal-package import rules.
type CRM = crminternal.CRM
