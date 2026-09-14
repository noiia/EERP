package presence

import (
	"context"
	"fmt"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is the tenant-pinned presence store. It bypasses the generic
// orm.Repository[T] facade for writes — that facade has no natural-key
// upsert, and presence rows are addressed by (tenant_id, user_id), not by
// their own id — so SetConnected/SetManualStatus go through raw SQL against
// the SAME table orm.Register[UserPresence] migrates (core/modules/presence).
type Repository struct {
	db *orm.DB
}

// NewRepository wires the presence repository.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{db: db}
}

// SetConnected records a WebSocket connect/disconnect for the user, creating
// the row on first contact. LastSeen always advances to now — on connect it's
// "since when has this user been online", on disconnect it's the instant
// Effective's absentAfter countdown starts from.
func (r *Repository) SetConnected(ctx context.Context, tenantID, userID uuid.UUID, connected bool) (UserPresence, error) {
	return r.upsert(ctx, `
		INSERT INTO user_presence (id, tenant_id, user_id, connected, last_seen, created_at, updated_at)
		VALUES ($1, $2, $3, $4, now(), now(), now())
		ON CONFLICT (tenant_id, user_id) DO UPDATE
		SET connected = EXCLUDED.connected, last_seen = now(), updated_at = now()
		RETURNING id, tenant_id, user_id, manual_status, connected, last_seen, created_at, updated_at
	`, uuid.New(), tenantID, userID, connected)
}

// SetManualStatus applies the user's own override ("" clears it — see
// ValidManualStatus). Does not touch Connected/LastSeen.
func (r *Repository) SetManualStatus(ctx context.Context, tenantID, userID uuid.UUID, status string) (UserPresence, error) {
	var manual *string
	if status != "" {
		manual = &status
	}
	return r.upsert(ctx, `
		INSERT INTO user_presence (id, tenant_id, user_id, manual_status, connected, last_seen, created_at, updated_at)
		VALUES ($1, $2, $3, $4, false, now(), now(), now())
		ON CONFLICT (tenant_id, user_id) DO UPDATE
		SET manual_status = EXCLUDED.manual_status, updated_at = now()
		RETURNING id, tenant_id, user_id, manual_status, connected, last_seen, created_at, updated_at
	`, uuid.New(), tenantID, userID, manual)
}

func (r *Repository) upsert(ctx context.Context, sql string, args ...any) (UserPresence, error) {
	var p UserPresence
	err := r.db.QueryRow(ctx, sql, args...).Scan(
		&p.ID, &p.TenantID, &p.UserID, &p.ManualStatus, &p.Connected, &p.LastSeen, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return UserPresence{}, fmt.Errorf("presence: upsert: %w", err)
	}
	return p, nil
}

// ListByTenant returns every presence row for the tenant — only users who
// have connected or set a status at least once; a user with no row yet
// simply isn't in the result, and the frontend defaults an unknown user to
// offline (see presence-store.ts).
func (r *Repository) ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]UserPresence, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, tenant_id, user_id, manual_status, connected, last_seen, created_at, updated_at
		FROM user_presence
		WHERE tenant_id = $1
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("presence: list by tenant: %w", err)
	}
	defer rows.Close()

	var out []UserPresence
	for rows.Next() {
		var p UserPresence
		if err := rows.Scan(&p.ID, &p.TenantID, &p.UserID, &p.ManualStatus, &p.Connected, &p.LastSeen, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("presence: scan: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("presence: list by tenant: %w", err)
	}
	return out, nil
}

// ListDisconnectedPast returns every row disconnected since before cutoff —
// used by the sweeper to broadcast the absent -> offline transition.
func (r *Repository) ListDisconnectedPast(ctx context.Context, cutoff time.Time) ([]UserPresence, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, tenant_id, user_id, manual_status, connected, last_seen, created_at, updated_at
		FROM user_presence
		WHERE connected = false AND last_seen < $1
	`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("presence: list disconnected: %w", err)
	}
	defer rows.Close()

	var out []UserPresence
	for rows.Next() {
		var p UserPresence
		if err := rows.Scan(&p.ID, &p.TenantID, &p.UserID, &p.ManualStatus, &p.Connected, &p.LastSeen, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("presence: scan: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("presence: list disconnected: %w", err)
	}
	return out, nil
}
