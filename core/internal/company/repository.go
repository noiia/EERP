package company

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Repository reads and writes companies and resolves a caller's active one.
type Repository struct {
	db *orm.DB
}

// NewRepository constructs a Repository bound to db.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{db: db}
}

// FindByID returns the tenant's company with the given id. Returns
// orm.ErrNotFound if absent, soft-deleted, or belongs to another tenant —
// the same shape either way, so a cross-tenant probe learns nothing.
func (r *Repository) FindByID(ctx context.Context, tenantID, id uuid.UUID) (Company, error) {
	var c Company
	err := r.db.QueryRow(ctx, `
		SELECT id, tenant_id, name,
			address_number, address_complement, address_street, address_zip_code,
			address_city, address_state, address_country,
			phone, email, is_default
		FROM company
		WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
	`, id, tenantID).Scan(
		&c.ID, &c.TenantID, &c.Name,
		&c.AddressNumber, &c.AddressComplement, &c.AddressStreet, &c.AddressZipCode,
		&c.AddressCity, &c.AddressState, &c.AddressCountry,
		&c.Phone, &c.Email, &c.IsDefault,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Company{}, fmt.Errorf("company: find by id: %w", orm.ErrNotFound)
		}
		return Company{}, fmt.Errorf("company: find by id: %w", err)
	}
	return c, nil
}

// EnsureDefaultCompany race-safely creates the tenant's one bootstrap
// company if none exists yet, and returns it either way. The ON CONFLICT
// predicate below must match module.go's uq_company_tenant_default index
// predicate verbatim — Postgres requires syntactic, not just semantic,
// equality between an index predicate and its ON CONFLICT target. Two
// concurrent inserts for the same tenant: the second blocks on the first's
// row lock, then no-ops once it commits — no advisory lock needed. Exported
// for reuse by core/modules/settings' one-time migration backfill (which has
// no user id to resolve a full ResolveActive against) as well as
// ResolveActive itself.
func (r *Repository) EnsureDefaultCompany(ctx context.Context, tenantID uuid.UUID) (Company, error) {
	if _, err := r.db.Exec(ctx, `
		INSERT INTO company (tenant_id, name, is_default)
		VALUES ($1, 'Default Company', true)
		ON CONFLICT (tenant_id) WHERE is_default DO NOTHING
	`, tenantID); err != nil {
		return Company{}, fmt.Errorf("company: ensure default: %w", err)
	}

	var c Company
	err := r.db.QueryRow(ctx, `
		SELECT id, tenant_id, name,
			address_number, address_complement, address_street, address_zip_code,
			address_city, address_state, address_country,
			phone, email, is_default
		FROM company
		WHERE tenant_id = $1 AND is_default AND deleted_at IS NULL
	`, tenantID).Scan(
		&c.ID, &c.TenantID, &c.Name,
		&c.AddressNumber, &c.AddressComplement, &c.AddressStreet, &c.AddressZipCode,
		&c.AddressCity, &c.AddressState, &c.AddressCountry,
		&c.Phone, &c.Email, &c.IsDefault,
	)
	if err != nil {
		return Company{}, fmt.Errorf("company: read default: %w", err)
	}
	return c, nil
}

// ResolveActive returns the caller's currently active company, bootstrapping
// the tenant's default company — and the caller's own selection, if unset —
// on first touch. Concurrent first-touches for the same brand-new user
// converge on the same company id: both read/write against the SAME
// COALESCE fallback (the tenant's one default company), and the UPDATE's
// row lock serializes them. Pre-existing app_settings/report_page_format
// rows are backfilled once, eagerly, at boot (each owning module's own
// Migrate() — settings' and reportlayout's) rather than lazily here, so this
// method has no backfill work of its own to do.
func (r *Repository) ResolveActive(ctx context.Context, tenantID, userID uuid.UUID) (Company, error) {
	def, err := r.EnsureDefaultCompany(ctx, tenantID)
	if err != nil {
		return Company{}, err
	}

	var activeID uuid.UUID
	err = r.db.QueryRow(ctx, `
		UPDATE users
		SET active_company_id = COALESCE(active_company_id, $2), updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING active_company_id
	`, userID, def.ID).Scan(&activeID)
	if err != nil {
		return Company{}, fmt.Errorf("company: resolve active: %w", err)
	}

	if activeID == def.ID {
		return def, nil
	}
	return r.FindByID(ctx, tenantID, activeID)
}

// BackfillCompanyID sets company_id on every row of table (which must carry
// tenant_id and company_id columns) still left NULL from before this
// feature shipped, resolving each distinct tenant's lazily-bootstrapped
// default company via EnsureDefaultCompany. Meant to run once, eagerly, from
// a Go module's own Migrate() hook (see core/modules/settings and
// core/modules/reportlayout) — not per-request, unlike ResolveActive.
func (r *Repository) BackfillCompanyID(ctx context.Context, table string) error {
	// #nosec G201 -- table is a fixed caller-supplied constant, never user input.
	rows, err := r.db.Query(ctx, fmt.Sprintf(`SELECT DISTINCT tenant_id FROM %s WHERE company_id IS NULL`, table))
	if err != nil {
		return fmt.Errorf("company: find tenants needing backfill on %s: %w", table, err)
	}
	var tenantIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("company: scan tenant id: %w", err)
		}
		tenantIDs = append(tenantIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("company: iterate tenants: %w", err)
	}

	for _, tenantID := range tenantIDs {
		def, err := r.EnsureDefaultCompany(ctx, tenantID)
		if err != nil {
			return fmt.Errorf("company: ensure default for backfill: %w", err)
		}
		// #nosec G201 -- table is a fixed caller-supplied constant, never user input.
		if _, err := r.db.Exec(ctx,
			fmt.Sprintf(`UPDATE %s SET company_id = $1 WHERE tenant_id = $2 AND company_id IS NULL`, table),
			def.ID, tenantID,
		); err != nil {
			return fmt.Errorf("company: backfill company_id on %s: %w", table, err)
		}
	}
	return nil
}
