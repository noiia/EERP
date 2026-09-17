package presence

import (
	"context"
	"fmt"
	"time"

	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// conflictColumns is the natural key the table's own unique index enforces
// (core/modules/presence/module.go's Migrate) — one row per (tenant, user),
// not addressed by its own id the way orm.Repository.Update's PK lookup
// expects.
var conflictColumns = []string{"tenant_id", "user_id"}

// Repository is the tenant-pinned presence store, over the generic
// orm.Repository[T] facade (orm.Repository.Upsert — a natural-key upsert,
// since presence rows are addressed by (tenant_id, user_id), not their own
// id) — the SAME table orm.Register[UserPresence] migrates
// (core/modules/presence).
type Repository struct {
	presence *orm.Repository[UserPresence]
}

// NewRepository wires the presence repository.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{presence: orm.MustRepo[UserPresence](db)}
}

// SetConnected records a WebSocket connect/disconnect for the user, creating
// the row on first contact. LastSeen always advances to now — on connect it's
// "since when has this user been online", on disconnect it's the instant
// Effective's absentAfter countdown starts from. The upsert's SET fragment
// deliberately leaves ManualStatus out — a busy/do_not_disturb override
// survives a connect/disconnect (see status.go's Effective doc comment).
func (r *Repository) SetConnected(ctx context.Context, tenantID, userID uuid.UUID, connected bool) (UserPresence, error) {
	row, err := r.presence.Upsert(ctx,
		UserPresence{BaseModel: model.BaseModel{TenantID: tenantID}, UserID: userID, Connected: connected, LastSeen: time.Now()},
		conflictColumns,
		"connected = EXCLUDED.connected, last_seen = now(), updated_at = now()",
	)
	if err != nil {
		return UserPresence{}, fmt.Errorf("presence: set connected: %w", err)
	}
	return row, nil
}

// SetManualStatus applies the user's own override ("" clears it — see
// ValidManualStatus). The upsert's SET fragment deliberately leaves
// Connected/LastSeen out — setting a status doesn't affect the live
// connection state.
func (r *Repository) SetManualStatus(ctx context.Context, tenantID, userID uuid.UUID, status string) (UserPresence, error) {
	var manual *string
	if status != "" {
		manual = &status
	}
	row, err := r.presence.Upsert(ctx,
		UserPresence{BaseModel: model.BaseModel{TenantID: tenantID}, UserID: userID, ManualStatus: manual, LastSeen: time.Now()},
		conflictColumns,
		"manual_status = EXCLUDED.manual_status, updated_at = now()",
	)
	if err != nil {
		return UserPresence{}, fmt.Errorf("presence: set manual status: %w", err)
	}
	return row, nil
}

// ListByTenant returns every presence row for the tenant — only users who
// have connected or set a status at least once; a user with no row yet
// simply isn't in the result, and the frontend defaults an unknown user to
// offline (see presence-store.ts).
func (r *Repository) ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]UserPresence, error) {
	rows, err := r.presence.FindAll(ctx, orm.Cond("tenant_id = $1", tenantID))
	if err != nil {
		return nil, fmt.Errorf("presence: list by tenant: %w", err)
	}
	return rows, nil
}

// ListDisconnectedPast returns every row disconnected since before cutoff —
// used by the sweeper to broadcast the absent -> offline transition.
func (r *Repository) ListDisconnectedPast(ctx context.Context, cutoff time.Time) ([]UserPresence, error) {
	rows, err := r.presence.FindAll(ctx,
		orm.Cond("connected = false"),
		orm.Cond("last_seen < $1", cutoff),
	)
	if err != nil {
		return nil, fmt.Errorf("presence: list disconnected: %w", err)
	}
	return rows, nil
}
