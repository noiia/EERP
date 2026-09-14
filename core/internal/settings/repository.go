package settings

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Repository reads and writes tenant-scoped settings.
type Repository struct {
	db *orm.DB
}

// NewRepository constructs a Repository bound to db.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{db: db}
}

// Get returns the value stored for (tenantID, companyID, key). The boolean
// reports whether the setting exists — absent and empty are different
// states to callers that treat "" as a meaningful value.
func (r *Repository) Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error) {
	var value string
	err := r.db.QueryRow(ctx, `
		SELECT value FROM app_settings
		WHERE tenant_id = $1 AND company_id = $2 AND key = $3 AND deleted_at IS NULL
	`, tenantID, companyID, key).Scan(&value)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("settings: get %s: %w", key, err)
	}
	return value, true, nil
}

// Set upserts the value for (tenantID, companyID, key), relying on the
// unique index the settings module migration creates.
func (r *Repository) Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO app_settings (tenant_id, company_id, key, value)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (tenant_id, company_id, key)
		DO UPDATE SET value = EXCLUDED.value, updated_at = now(), deleted_at = NULL
	`, tenantID, companyID, key, value)
	if err != nil {
		return fmt.Errorf("settings: set %s: %w", key, err)
	}
	return nil
}

// CloneCompanySettings copies every setting from one company to another
// under the same keys/values — a one-time deep copy at company-creation
// time (a new company starts from the creator's current active company),
// not an ongoing inheritance. Idempotent: a retried call is a no-op for
// keys already cloned.
func (r *Repository) CloneCompanySettings(ctx context.Context, tenantID, fromCompanyID, toCompanyID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO app_settings (tenant_id, company_id, key, value)
		SELECT tenant_id, $3, key, value FROM app_settings
		WHERE tenant_id = $1 AND company_id = $2 AND deleted_at IS NULL
		ON CONFLICT (tenant_id, company_id, key)
		DO UPDATE SET value = EXCLUDED.value, updated_at = now(), deleted_at = NULL
	`, tenantID, fromCompanyID, toCompanyID)
	if err != nil {
		return fmt.Errorf("settings: clone company settings: %w", err)
	}
	return nil
}
