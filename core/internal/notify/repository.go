package notify

import (
	"context"
	"fmt"

	"core/orm"
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
