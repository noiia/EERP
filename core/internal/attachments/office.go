package attachments

import (
	"context"
	"errors"

	"core/internal/auth"
	"core/internal/office"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Record attachments retain their existing read permission and row-scope checks.
// They open read-only: replacing a field's file remains its existing form action.
func (h *Handler) OfficeSource(canRead func(context.Context, []string, string) (bool, error)) office.Source {
	return office.Source{Resolve: func(c *echo.Context, id uuid.UUID) (office.Document, bool, error) {
		ctx := c.Request().Context()
		identity := auth.MustIdentity(ctx)
		allowed, err := canRead(ctx, identity.Roles, "attachments:attachments:read")
		if err != nil {
			return office.Document{}, false, err
		}
		if !allowed {
			return office.Document{}, false, errorJSON(c, 403, "FORBIDDEN", "Your role does not allow this.")
		}
		a, err := h.store.FindInTenant(ctx, identity.TenantID, id)
		if errors.Is(err, orm.ErrNotFound) {
			return office.Document{}, false, errorJSON(c, 404, "NOT_FOUND", "No such attachment.")
		}
		if err != nil {
			return office.Document{}, false, err
		}
		if hidden, err := h.hidden(ctx, a.TableName, a.RecordID); hidden || err != nil {
			if err != nil {
				return office.Document{}, false, err
			}
			return office.Document{}, false, errorJSON(c, 404, "NOT_FOUND", "No such attachment.")
		}
		return office.Document{ID: a.ID, Name: a.Filename, Mime: a.Mime, ObjectKey: a.ObjectKey, Size: a.Size}, true, nil
	}}
}
