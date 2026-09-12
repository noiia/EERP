package cron

import (
	"context"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is this package's own tenant-pinned cron_history reader — used
// ONLY by the log-download handler. Every other cron_history operation
// (list/get/create/update/delete) goes through the generic CRUD surface
// instead, since — unlike chatter/notebook/savedfilter — this table has no
// visibility rule the generic column-filter chain can't express (see
// docs/adr/ADR-016-cron-scheduler.md).
type Repository struct {
	histories *orm.Repository[CronHistory]
}

// NewRepository wires the cron_history reader. Call once at startup.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{histories: orm.MustRepo[CronHistory](db)}
}

// FindInTenant returns a cron_history row by id, tenant-pinned.
func (r *Repository) FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (CronHistory, error) {
	rows, err := r.histories.FindAll(ctx,
		orm.Cond("id = $1", id),
		orm.Cond("tenant_id = $1", tenantID))
	if err != nil {
		return CronHistory{}, fmt.Errorf("cron: find history: %w", err)
	}
	if len(rows) == 0 {
		return CronHistory{}, orm.ErrNotFound
	}
	return rows[0], nil
}
