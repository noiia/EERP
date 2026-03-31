package models

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
type BaseModel struct {
	ID        uuid.UUID  `db:"id,pk"`
	CreatedAt time.Time  `db:"created_at"`
	UpdatedAt time.Time  `db:"updated_at"`
	DeletedAt *time.Time `db:"deleted_at,softdelete"`
}
