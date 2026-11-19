package model

import (
	"time"

	"github.com/google/uuid"
)

// BaseModel is the canonical base for every ERP entity.
// Embed it anonymously in your domain structs.
//
// Tags:
//   - ID        → "id,pk"       — primary key, auto-generated UUID
//   - CreatedAt → "created_at"  — set on INSERT
//   - UpdatedAt → "updated_at"  — set on INSERT and UPDATE
//   - DeletedAt → "deleted_at,softdelete" — nil means active; non-nil means soft-deleted
//   - TenantID  → "tenant_id,index" — the owning tenant; row isolation boundary
//
// TenantID is indexed unconditionally: every generic CRUD read/write
// WHERE-scopes by it (core/orm/internal/crud's tenantScoped), so every table
// benefits, not just the handful that used to opt in by hand before this
// field was promoted here.
//
// A genuinely tenant-less table (a workspace-wide catalog — auth.Permissions
// — a row scoped by a different FK instead — auth.RefreshTokens, via
// UserID — or boot-time infra bookkeeping that predates tenants entirely —
// module.ModuleOperationLog) does NOT embed BaseModel; it hand-declares the
// other three fields instead, the same way pictures.Picture/
// attachments.Attachment already opt out of DeletedAt. Go's embedding has no
// per-field opt-out — "don't want this one promoted field" means "don't
// embed, declare the rest by hand."
type BaseModel struct {
	ID        uuid.UUID  `db:"id,pk"`
	CreatedAt time.Time  `db:"created_at"`
	UpdatedAt time.Time  `db:"updated_at"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
	TenantID  uuid.UUID  `db:"tenant_id,index"`
}
