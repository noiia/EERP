package contact

import (
	"context"
	"errors"

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
