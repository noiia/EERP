package internal

import (
	"context"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

type Contact struct {
	model.BaseModel
	TenantID uuid.UUID `db:"tenant_id"` // owning tenant; set server-side, enforces row isolation
	Name     string    `db:"name"`
	Email    string    `db:"email"`
	Company  string    `db:"company"`
	Status   string    `db:"status"` // "lead", "prospect", "customer", "churned"
}

type Service struct {
	contacts *orm.Repository[Contact]
	db       *orm.DB
}

// New wires the Contact service to the database.
// Call once at startup — panics if the Contact struct tags are invalid.
func New(db *orm.DB) *Service {
	return &Service{
		contacts: orm.MustRepo[Contact](db),
		db:       db,
	}
}

// Create inserts a new contact and returns it with all server-set fields populated
// (id, created_at, updated_at via RETURNING *).
func (s *Service) Create(ctx context.Context, contact Contact) (Contact, error) {
	return s.contacts.Create(ctx, contact)
}

// GetByID returns a contact by UUID.
// Returns an error wrapping pgx.ErrNoRows when not found or soft-deleted.
func (s *Service) GetByID(ctx context.Context, id uuid.UUID) (Contact, error) {
	return s.contacts.FindByID(ctx, id)
}

// List returns all active (non-soft-deleted) contacts.
func (s *Service) List(ctx context.Context) ([]Contact, error) {
	return s.contacts.FindAll(ctx)
}

// ListByStatus returns active contacts filtered by their status value.
func (s *Service) ListByStatus(ctx context.Context, status string) ([]Contact, error) {
	return s.contacts.FindAll(ctx, orm.Cond("status = $1", status))
}

// ListByCompany drops to the SelectBuilder for custom ordering — the right
// tier when FindAll's conditions aren't expressive enough.
func (s *Service) ListByCompany(ctx context.Context, company string) ([]Contact, error) {
	return s.contacts.Query().
		Where(orm.Cond("company = $1", company)).
		Where(orm.Cond("deleted_at IS NULL")). // Query() has no implicit soft-delete filter
		OrderBy("name ASC").
		All(ctx, s.db)
}

// Update overwrites all writable fields for the contact with the given ID.
// updated_at is set automatically; soft-deleted rows are excluded.
func (s *Service) Update(ctx context.Context, contact Contact, id uuid.UUID) (Contact, error) {
	return s.contacts.Update(ctx, contact, id)
}

// Delete soft-deletes the contact (sets deleted_at = now).
// The row is excluded from all future queries but can be Restored.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) (int64, error) {
	return s.contacts.Delete(ctx, id)
}

// Restore clears deleted_at for a previously soft-deleted contact.
func (s *Service) Restore(ctx context.Context, id uuid.UUID) error {
	return s.contacts.Restore(ctx, id)
}

// ConvertToCustomer atomically changes a contact's status to "customer".
// Shows the read-modify-write pattern inside a transaction: both operations
// share the same Tx so they are committed or rolled back together.
func (s *Service) ConvertToCustomer(ctx context.Context, id uuid.UUID) (Contact, error) {
	var updated Contact
	err := orm.Transact(ctx, s.db, func(tx *orm.Tx) error {
		txContacts := s.contacts.WithTx(tx)

		contact, err := txContacts.FindByID(ctx, id)
		if err != nil {
			return err
		}

		contact.Status = "customer"
		updated, err = txContacts.Update(ctx, contact, id)
		return err
	})
	return updated, err
}
