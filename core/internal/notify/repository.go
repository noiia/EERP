package notify

import (
	"context"
	"fmt"
	"time"

	"core/orm"

	"github.com/google/uuid"
)

// Repository is the notification store. Every read is tenant- and
// user-scoped (see Feed); nothing here lists another user's personal rows.
type Repository struct {
	db *orm.DB
}

// NewRepository wires the store.
func NewRepository(db *orm.DB) *Repository { return &Repository{db: db} }

// SyncCatalog copies every registered category into each known tenant's
// catalog (a tenant = one with a live user). A category new to a tenant is
// also granted to that tenant's "admin" role — only then, so an admin who
// later removes it doesn't see it come back on the next boot.
func (r *Repository) SyncCatalog(ctx context.Context) error {
	for _, c := range Categories() {
		rows, err := r.db.Query(ctx, `
			INSERT INTO notification_category (tenant_id, key, label, name)
			SELECT DISTINCT u.tenant_id, $1, $2, $2 FROM users u
			WHERE u.deleted_at IS NULL
			  AND NOT EXISTS (SELECT 1 FROM notification_category nc
			                  WHERE nc.tenant_id = u.tenant_id AND nc.key = $1 AND nc.deleted_at IS NULL)
			RETURNING id, tenant_id`, c.Key, c.Label)
		if err != nil {
			return fmt.Errorf("notify: sync catalog %s: %w", c.Key, err)
		}
		type added struct{ id, tenant any }
		var news []added
		for rows.Next() {
			var a added
			if err := rows.Scan(&a.id, &a.tenant); err != nil {
				rows.Close()
				return err
			}
			news = append(news, a)
		}
		rows.Close()
		for _, a := range news {
			if _, err := r.db.Exec(ctx, `
				INSERT INTO role_notification_category (tenant_id, role_id, notification_category_id)
				SELECT $1, r.id, $2 FROM roles r
				WHERE r.tenant_id = $1 AND r.technical_name = 'admin' AND r.deleted_at IS NULL`, a.tenant, a.id); err != nil {
				return fmt.Errorf("notify: admin default %s: %w", c.Key, err)
			}
		}
		// Labels follow the registry.
		if _, err := r.db.Exec(ctx, `UPDATE notification_category SET label = $2, name = $2 WHERE key = $1 AND label <> $2`, c.Key, c.Label); err != nil {
			return fmt.Errorf("notify: relabel %s: %w", c.Key, err)
		}
	}
	return nil
}

// DB exposes the pool to tests and to the module's Migrate.
func (r *Repository) DB() *orm.DB { return r.db }

// columns and nColumns list the same columns in the same order — scanNotification's.
const columns = `id, tenant_id, created_at, updated_at, deleted_at, user_id, category, kind, title, body, link,
	status, progress, progress_label, actor_id, finished_at, data`

const nColumns = `n.id, n.tenant_id, n.created_at, n.updated_at, n.deleted_at, n.user_id, n.category, n.kind, n.title,
	n.body, n.link, n.status, n.progress, n.progress_label, n.actor_id, n.finished_at, n.data`

func scanNotification(row interface{ Scan(...any) error }) (Notification, error) {
	var n Notification
	err := row.Scan(&n.ID, &n.TenantID, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt, &n.UserID, &n.Category, &n.Kind,
		&n.Title, &n.Body, &n.Link, &n.Status, &n.Progress, &n.ProgressLabel, &n.ActorID, &n.FinishedAt, &n.Data)
	return n, err
}

// Create inserts n and returns it with server-set fields.
func (r *Repository) Create(ctx context.Context, n Notification) (Notification, error) {
	row := r.db.QueryRow(ctx, `
		INSERT INTO notification (tenant_id, user_id, category, kind, title, body, link, status, progress, progress_label, actor_id, data)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		RETURNING `+columns,
		n.TenantID, n.UserID, n.Category, n.Kind, n.Title, n.Body, n.Link, n.Status, n.Progress, n.ProgressLabel, n.ActorID, n.Data)
	out, err := scanNotification(row)
	if err != nil {
		return Notification{}, fmt.Errorf("notify: create: %w", err)
	}
	return out, nil
}

// ActivityUpdate is a partial update of an activity row; nil fields are kept.
type ActivityUpdate struct {
	Status        *string
	Progress      *int
	ProgressLabel *string
	Body          *string
	Data          *string
	Finished      bool
}

// UpdateActivity applies u to the activity id and returns the row.
func (r *Repository) UpdateActivity(ctx context.Context, id uuid.UUID, u ActivityUpdate) (Notification, error) {
	row := r.db.QueryRow(ctx, `
		UPDATE notification SET
			status = COALESCE($2, status),
			progress = COALESCE($3, progress),
			progress_label = COALESCE($4, progress_label),
			body = COALESCE($5, body),
			data = COALESCE($6, data),
			finished_at = CASE WHEN $7 THEN now() ELSE finished_at END,
			updated_at = now()
		WHERE id = $1
		RETURNING `+columns, id, u.Status, u.Progress, u.ProgressLabel, u.Body, u.Data, u.Finished)
	out, err := scanNotification(row)
	if err != nil {
		return Notification{}, fmt.Errorf("notify: update activity: %w", err)
	}
	return out, nil
}

// closureCTE resolves every (user, role) pair of a tenant through user_roles
// plus role_belongs, transitively — the same closure UserRepository.FindGroups
// walks for one user. UNION (not ALL) makes cycles terminate.
const closureCTE = `
	WITH RECURSIVE closure(user_id, role_id) AS (
		SELECT ur.user_id, ur.role_id
		FROM user_roles ur JOIN users u ON u.id = ur.user_id
		WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND ur.deleted_at IS NULL
		UNION
		SELECT c.user_id, rb.belongs_to_role_id
		FROM closure c JOIN role_belongs rb ON rb.role_id = c.role_id AND rb.deleted_at IS NULL
	)`

// CallerCategories returns the categories a user's roles allow — read live
// from the database, so a role change applies on the next request.
func (r *Repository) CallerCategories(ctx context.Context, tenant, user uuid.UUID) ([]string, error) {
	rows, err := r.db.Query(ctx, closureCTE+`
		SELECT DISTINCT nc.key
		FROM closure c
		JOIN roles ro ON ro.id = c.role_id AND ro.deleted_at IS NULL
		JOIN role_notification_category rnc ON rnc.role_id = c.role_id AND rnc.deleted_at IS NULL
		JOIN notification_category nc ON nc.id = rnc.notification_category_id AND nc.deleted_at IS NULL
		WHERE c.user_id = $2`, tenant, user)
	if err != nil {
		return nil, fmt.Errorf("notify: caller categories: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// Audience returns every user of the tenant allowed the category — who a
// global notification of that category is sent to.
func (r *Repository) Audience(ctx context.Context, tenant uuid.UUID, category string) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, closureCTE+`
		SELECT DISTINCT c.user_id
		FROM closure c
		JOIN roles ro ON ro.id = c.role_id AND ro.deleted_at IS NULL
		JOIN role_notification_category rnc ON rnc.role_id = c.role_id AND rnc.deleted_at IS NULL
		JOIN notification_category nc ON nc.id = rnc.notification_category_id AND nc.deleted_at IS NULL
		WHERE nc.key = $2`, tenant, category)
	if err != nil {
		return nil, fmt.Errorf("notify: audience: %w", err)
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// visible is THE privacy filter: $1 tenant, $2 caller, $3 caller's categories.
const visible = `n.tenant_id = $1 AND n.deleted_at IS NULL
	AND (n.user_id = $2 OR (n.user_id IS NULL AND n.category = ANY($3)))`

// FeedItem is one feed row with the caller's read state. Notification is
// excluded from JSON; handlers serialize WireItem.
type FeedItem struct {
	Notification `json:"-"`
	Read         bool `json:"read"`
}

// feedLimit caps one feed read; retention keeps the table small anyway.
const feedLimit = 100

// Feed returns what the caller may see — running activities first, then the
// rest newest first — and how many of those are unread.
func (r *Repository) Feed(ctx context.Context, tenant, user uuid.UUID) ([]FeedItem, int, error) {
	cats, err := r.CallerCategories(ctx, tenant, user)
	if err != nil {
		return nil, 0, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT `+nColumns+`, (nr.id IS NOT NULL) AS read
		FROM notification n
		LEFT JOIN notification_read nr ON nr.notification_id = n.id AND nr.user_id = $2
		WHERE `+visible+`
		ORDER BY (n.status = 'running') DESC NULLS LAST, n.created_at DESC
		LIMIT `+fmt.Sprint(feedLimit), tenant, user, cats)
	if err != nil {
		return nil, 0, fmt.Errorf("notify: feed: %w", err)
	}
	defer rows.Close()
	var items []FeedItem
	unread := 0
	for rows.Next() {
		var it FeedItem
		n := &it.Notification
		if err := rows.Scan(&n.ID, &n.TenantID, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt, &n.UserID, &n.Category, &n.Kind,
			&n.Title, &n.Body, &n.Link, &n.Status, &n.Progress, &n.ProgressLabel, &n.ActorID, &n.FinishedAt, &n.Data, &it.Read); err != nil {
			return nil, 0, err
		}
		if !it.Read {
			unread++
		}
		items = append(items, it)
	}
	return items, unread, rows.Err()
}

// MarkRead marks the given notifications (or every visible one, with all)
// read for the caller, and returns the ids it actually marked: ids the caller
// can't see are ignored, never reported (no existence oracle).
func (r *Repository) MarkRead(ctx context.Context, tenant, user uuid.UUID, ids []uuid.UUID, all bool) ([]uuid.UUID, error) {
	cats, err := r.CallerCategories(ctx, tenant, user)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `
		INSERT INTO notification_read (tenant_id, user_id, notification_id, read_at)
		SELECT $1, $2, n.id, now() FROM notification n
		WHERE `+visible+` AND ($4 OR n.id = ANY($5))
		ON CONFLICT (user_id, notification_id) DO NOTHING
		RETURNING notification_id`, tenant, user, cats, all, ids)
	if err != nil {
		return nil, fmt.Errorf("notify: mark read: %w", err)
	}
	defer rows.Close()
	var marked []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		marked = append(marked, id)
	}
	return marked, rows.Err()
}

// Retention windows (spec: 7 days for finished global activities, 30 for personal).
const (
	globalRetention   = 7 * 24 * time.Hour
	personalRetention = 30 * 24 * time.Hour
)

// Sweep hard-deletes expired notifications and their read marks.
func (r *Repository) Sweep(ctx context.Context, now time.Time) (int64, error) {
	tag, err := r.db.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM notification
			WHERE (user_id IS NULL AND status IS DISTINCT FROM 'running' AND created_at < $1)
			   OR (user_id IS NOT NULL AND created_at < $2)
		), reads AS (
			DELETE FROM notification_read WHERE notification_id IN (SELECT id FROM expired)
		)
		DELETE FROM notification WHERE id IN (SELECT id FROM expired)`,
		now.Add(-globalRetention), now.Add(-personalRetention))
	if err != nil {
		return 0, fmt.Errorf("notify: sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}

// FailInterrupted marks every running activity failed — at boot, the process
// that ran them is gone (and their transactions were rolled back).
func (r *Repository) FailInterrupted(ctx context.Context) (int64, error) {
	tag, err := r.db.Exec(ctx, `
		UPDATE notification SET status = 'failed', body = 'Interrupted by a restart', finished_at = now(), updated_at = now()
		WHERE status = 'running'`)
	if err != nil {
		return 0, fmt.Errorf("notify: fail interrupted: %w", err)
	}
	return tag.RowsAffected(), nil
}

// RunningActivity returns the newest running global activity of category in
// tenant, or nil.
func (r *Repository) RunningActivity(ctx context.Context, tenant uuid.UUID, category string) (*Notification, error) {
	rows, err := r.db.Query(ctx, `SELECT `+columns+` FROM notification
		WHERE tenant_id = $1 AND category = $2 AND user_id IS NULL AND status = 'running' AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 1`, tenant, category)
	if err != nil {
		return nil, fmt.Errorf("notify: running activity: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	n, err := scanNotification(rows)
	if err != nil {
		return nil, err
	}
	return &n, nil
}
