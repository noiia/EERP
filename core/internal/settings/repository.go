package settings

import (
	"context"
	"errors"
	"fmt"

	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// settingsConflictColumns is the natural key the module's own Migrate() hook
// indexes uniquely — one row per (tenant, company, key).
var settingsConflictColumns = []string{"tenant_id", "company_id", "key"}

// Repository reads and writes tenant-scoped settings. db is kept alongside
// the typed repository purely for CloneCompanySettings' bulk INSERT...SELECT
// — a multi-row copy from an arbitrary SELECT source has no single-entity
// shape orm.Repository[T] can express.
type Repository struct {
	settings *orm.Repository[AppSettings]
	db       *orm.DB
}

// NewRepository constructs a Repository bound to db.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{settings: orm.MustRepo[AppSettings](db), db: db}
}

// Get returns the value stored for (tenantID, companyID, key). The boolean
// reports whether the setting exists — absent and empty are different
// states to callers that treat "" as a meaningful value.
func (r *Repository) Get(ctx context.Context, tenantID, companyID uuid.UUID, key string) (string, bool, error) {
	row, err := r.settings.FindOne(ctx,
		orm.Cond("tenant_id = $1", tenantID),
		orm.Cond("company_id = $2", companyID),
		orm.Cond("key = $3", key),
	)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("settings: get %s: %w", key, err)
	}
	return row.Value, true, nil
}

// Set upserts the value for (tenantID, companyID, key), relying on the
// unique index the settings module migration creates. Un-deletes the row
// (deleted_at = NULL) on conflict too — a write always means "this setting
// is live now," even if it was previously cleared.
func (r *Repository) Set(ctx context.Context, tenantID, companyID uuid.UUID, key, value string) error {
	_, err := r.settings.Upsert(ctx,
		AppSettings{BaseModel: model.BaseModel{TenantID: tenantID}, CompanyID: &companyID, Key: key, Value: value},
		settingsConflictColumns,
		"value = EXCLUDED.value, updated_at = now(), deleted_at = NULL",
	)
	if err != nil {
		return fmt.Errorf("settings: set %s: %w", key, err)
	}
	return nil
}

// CloneCompanySettings copies every setting from one company to another
// under the same keys/values — a one-time deep copy at company-creation
// time (a new company starts from the creator's current active company),
// not an ongoing inheritance. Idempotent: a retried call is a no-op for
// keys already cloned. A bulk INSERT...SELECT, not a single-row shape
// Repository.Upsert addresses — stays raw SQL.
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
