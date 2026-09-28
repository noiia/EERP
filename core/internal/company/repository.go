package company

import (
	"context"
	"errors"
	"fmt"

	"core/orm"

	"github.com/google/uuid"
)

// Repository reads and writes companies and resolves a caller's active one.
// db is kept alongside the typed repository for the raw SQL EnsureDefaultCompany's
// INSERT (a partial-unique-index ON CONFLICT target Upsert can't express),
// ResolveActive's COALESCE-guarded UPDATE, and BackfillCompanyID's dynamic
// table name — none of which fit orm.Repository[T]'s single-entity shape.
type Repository struct {
	companies *orm.Repository[Company]
	db        *orm.DB
}

// NewRepository constructs a Repository bound to db.
func NewRepository(db *orm.DB) *Repository {
	return &Repository{companies: orm.MustRepo[Company](db), db: db}
}

// FindByID returns the tenant's company with the given id. Returns
// orm.ErrNotFound if absent, soft-deleted, or belongs to another tenant —
// the same shape either way, so a cross-tenant probe learns nothing.
func (r *Repository) FindByID(ctx context.Context, tenantID, id uuid.UUID) (Company, error) {
	c, err := r.companies.FindOne(ctx, orm.Cond("id = $1", id), orm.Cond("tenant_id = $2", tenantID))
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
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
// equality between an index predicate and its ON CONFLICT target — a
// partial-predicate conflict target orm.Repository.Upsert has no way to
// express, so the INSERT stays raw SQL. Two concurrent inserts for the same
// tenant: the second blocks on the first's row lock, then no-ops once it
// commits — no advisory lock needed. Exported for reuse by
// core/modules/settings' one-time migration backfill (which has no user id
// to resolve a full ResolveActive against) as well as ResolveActive itself.
func (r *Repository) EnsureDefaultCompany(ctx context.Context, tenantID uuid.UUID) (Company, error) {
	if _, err := r.db.Exec(ctx, `
		INSERT INTO company (tenant_id, name, is_default)
		VALUES ($1, 'Default Company', true)
		ON CONFLICT (tenant_id) WHERE is_default DO NOTHING
	`, tenantID); err != nil {
		return Company{}, fmt.Errorf("company: ensure default: %w", err)
	}

	c, err := r.companies.FindOne(ctx, orm.Cond("tenant_id = $1", tenantID), orm.Cond("is_default"))
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
// row lock serializes them — a raw SQL expression UpdateQuery's Set(col, val)
// has no way to express, so this stays hand-written. Pre-existing
// app_settings/report_page_format rows are backfilled once, eagerly, at boot
// (each owning module's own Migrate() — settings' and reportlayout's)
// rather than lazily here, so this method has no backfill work of its own
// to do.
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
// feature shipped, pointing it at its tenant's default company — created
// first if missing, exactly as EnsureDefaultCompany would. Meant to run once,
// eagerly, from a Go module's own Migrate() hook (see core/modules/settings
// and core/modules/reportlayout) — not per-request, unlike ResolveActive.
// table is a dynamic, caller-supplied identifier no struct/entity backs, so
// this stays raw SQL.
//
// Two set-based statements whatever the tenant count (it used to be two
// round trips per tenant). A tenant whose default company is soft-deleted
// keeps NULL rather than failing the boot.
func (r *Repository) BackfillCompanyID(ctx context.Context, table string) error {
	// #nosec G201 -- table is a fixed caller-supplied constant, never user input.
	if _, err := r.db.Exec(ctx, fmt.Sprintf(`
		INSERT INTO company (tenant_id, name, is_default)
		SELECT DISTINCT tenant_id, 'Default Company', true FROM %s WHERE company_id IS NULL
		ON CONFLICT (tenant_id) WHERE is_default DO NOTHING`, table)); err != nil {
		return fmt.Errorf("company: ensure defaults for backfill on %s: %w", table, err)
	}
	// #nosec G201 -- table is a fixed caller-supplied constant, never user input.
	if _, err := r.db.Exec(ctx, fmt.Sprintf(`
		UPDATE %s t SET company_id = c.id
		FROM company c
		WHERE c.tenant_id = t.tenant_id AND c.is_default AND c.deleted_at IS NULL
		  AND t.company_id IS NULL`, table)); err != nil {
		return fmt.Errorf("company: backfill company_id on %s: %w", table, err)
	}
	return nil
}
