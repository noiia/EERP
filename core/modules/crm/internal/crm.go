package internal

import (
	"context"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// crm is a CRM record — a person or company the business interacts with.
// The table name is derived automatically from the struct name: "crm".
type CRM struct {
	model.BaseModel
	Name     string    `db:"name"`
	Email    string    `db:"email"`
	Company  string    `db:"company"`
	Status   string    `db:"status"` // "lead", "prospect", "customer", "churned"
	Contacts uuid.UUID `db:"contact_id"`
}

// Service holds the CRM business logic, wired to the database at startup.
type Service struct {
	crms *orm.Repository[CRM]
	db   *orm.DB
}

// New wires the CRM service to the database.
// Call once at startup — panics if the crm struct tags are invalid.
func New(db *orm.DB) *Service {
	return &Service{
		crms: orm.MustRepo[CRM](db),
		db:   db,
	}
}

// Create inserts a new crm and returns it with all server-set fields populated
// (id, created_at, updated_at via RETURNING *).
func (s *Service) Create(ctx context.Context, crm CRM) (CRM, error) {
	return s.crms.Create(ctx, crm)
}

// GetByID returns a crm by UUID.
// Returns an error wrapping pgx.ErrNoRows when not found or soft-deleted.
func (s *Service) GetByID(ctx context.Context, id uuid.UUID) (CRM, error) {
	return s.crms.FindByID(ctx, id)
}

// List returns all active (non-soft-deleted) crms.
func (s *Service) List(ctx context.Context) ([]CRM, error) {
	return s.crms.FindAll(ctx)
}

// ListByStatus returns active crms filtered by their status value.
func (s *Service) ListByStatus(ctx context.Context, status string) ([]CRM, error) {
	return s.crms.FindAll(ctx, orm.Cond("status = $1", status))
}

// ListByCompany drops to the SelectBuilder for custom ordering — the right
// tier when FindAll's conditions aren't expressive enough.
func (s *Service) ListByCompany(ctx context.Context, company string) ([]CRM, error) {
	return s.crms.Query().
		Where(orm.Cond("company = $1", company)).
		Where(orm.Cond("deleted_at IS NULL")). // Query() has no implicit soft-delete filter
		OrderBy("name ASC").
		All(ctx, s.db)
}

// Update overwrites all writable fields for the crm with the given ID.
// updated_at is set automatically; soft-deleted rows are excluded.
func (s *Service) Update(ctx context.Context, crm CRM, id uuid.UUID) (CRM, error) {
	return s.crms.Update(ctx, crm, id)
}

// Delete soft-deletes the crm (sets deleted_at = now).
// The row is excluded from all future queries but can be Restored.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) (int64, error) {
	return s.crms.Delete(ctx, id)
}

// Restore clears deleted_at for a previously soft-deleted crm.
func (s *Service) Restore(ctx context.Context, id uuid.UUID) error {
	return s.crms.Restore(ctx, id)
}

// ConvertToCustomer atomically changes a crm's status to "customer".
// Shows the read-modify-write pattern inside a transaction: both operations
// share the same Tx so they are committed or rolled back together.
func (s *Service) ConvertToCustomer(ctx context.Context, id uuid.UUID) (CRM, error) {
	var updated CRM
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		txcrms := s.crms.WithTx(tx)

		crm, err := txcrms.FindByID(ctx, id)
		if err != nil {
			return err
		}

		crm.Status = "customer"
		updated, err = txcrms.Update(ctx, crm, id)
		return err
	})
	return updated, err
}
