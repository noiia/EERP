// Package access carries request-scoped caller attributes the generic CRUD layer
// needs for authorization — currently the tenant ID used to isolate rows.
//
// It deliberately lives in the orm tree rather than the application's auth
// package: the ORM is a reusable framework and must not import app-level code.
// The application stamps the tenant onto the request context (via its auth
// middleware calling WithTenant); the CRUD repository reads it back with
// TenantFromContext. Keeping the contract here means no import cycle and a single
// source of truth for how tenant scope travels through a request.
package access

import (
	"context"

	"github.com/google/uuid"
)

type tenantKey struct{}

// WithTenant returns a copy of ctx carrying the caller's tenant ID. The auth
// middleware calls this once per authenticated request.
func WithTenant(ctx context.Context, tenantID uuid.UUID) context.Context {
	return context.WithValue(ctx, tenantKey{}, tenantID)
}

// TenantFromContext returns the tenant ID stamped by WithTenant. ok is false when
// no tenant is present — an unauthenticated request or a middleware wiring gap.
// The CRUD layer treats a missing tenant on a tenant-scoped table as a hard error
// (fail closed), never as "all tenants".
func TenantFromContext(ctx context.Context) (id uuid.UUID, ok bool) {
	id, ok = ctx.Value(tenantKey{}).(uuid.UUID)
	return id, ok
}
