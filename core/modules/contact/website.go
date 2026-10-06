package contact

import (
	"context"
	"errors"
	"strings"

	"core/modules/contact/internal"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

// CreateWebsiteContact inserts the contact of a new website account
// (website = true). Called inside the signup transaction (auth's
// OnWebsiteSignup hook, wired in internal/app), so a failed signup leaves no
// contact. A new contact even when an ERP contact already has this email:
// "created from the website" is the fact recorded, merging is a human call.
func CreateWebsiteContact(ctx context.Context, ex orm.Executor, tenant uuid.UUID, name, email string) (uuid.UUID, error) {
	yes := true
	c, err := orm.MustRepo[internal.Contact](ex).Create(ctx, internal.Contact{
		BaseModel: model.BaseModel{TenantID: tenant}, Name: name, Email: email, Status: "lead", Website: &yes})
	return c.ID, err
}

// WebsiteContactID finds the website contact created for the account with
// this email; uuid.Nil when there is none (an account older than this link).
func WebsiteContactID(ctx context.Context, ex orm.Executor, tenant uuid.UUID, email string) (uuid.UUID, error) {
	c, err := orm.MustRepo[internal.Contact](ex).FindOne(ctx,
		orm.Cond("tenant_id = $1 AND lower(email) = lower($2) AND website IS TRUE", tenant, email))
	if errors.Is(err, orm.ErrNotFound) {
		return uuid.Nil, nil
	}
	return c.ID, err
}

// FindOrCreate returns the contact a booking (or any other record raised for
// a person known only by email) belongs to: the website contact of that
// email, else the oldest contact with it, else a new "customer" contact.
// Serialized per (tenant, email) with a transaction-scoped advisory lock, so
// concurrent first bookings create one contact — call it inside a
// transaction (ex = the *orm.Tx).
func FindOrCreate(ctx context.Context, ex orm.Executor, tenant uuid.UUID, name, email string) (uuid.UUID, error) {
	if _, err := ex.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"contact|"+tenant.String()+"|"+strings.ToLower(email)); err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err := ex.QueryRow(ctx, `SELECT id FROM contact WHERE tenant_id = $1 AND lower(email) = lower($2) AND deleted_at IS NULL
		ORDER BY website IS TRUE DESC, created_at LIMIT 1`, tenant, email).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, orm.ErrNotFound) {
		return uuid.Nil, err
	}
	c, err := orm.MustRepo[internal.Contact](ex).Create(ctx, internal.Contact{
		BaseModel: model.BaseModel{TenantID: tenant}, Name: name, Email: strings.ToLower(email), Status: "customer"})
	return c.ID, err
}
