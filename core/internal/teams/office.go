package teams

import (
	"errors"
	"fmt"

	"core/internal/auth"
	"core/internal/office"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// OfficeFiles reuses the exact file/share/folder visibility rules used by downloads.
// Read-only recipients never acquire write access through an editor session.
func (h *Handler) OfficeFiles(active func(string) bool) office.Source {
	resolve := func(c *echo.Context, id uuid.UUID) (office.Document, bool, error) {
		if !active("teams") {
			return office.Document{}, false, notFound(c, "file")
		}
		f, role, ok, err := h.fileRoleByID(c, true, id)
		if !ok {
			return office.Document{}, false, err
		}
		user := auth.MustIdentity(c.Request().Context())
		return office.Document{ID: f.ID, Name: f.Name, Mime: f.Mime, ObjectKey: f.ObjectKey, Size: f.Size, Writable: CanEditItem(role, f.UploadedBy, user.UserID)}, true, nil
	}
	return office.Source{Resolve: resolve, Replace: func(c *echo.Context, previous office.Document, key string, size int64) (bool, error) {
		// Resolve again at the write boundary; team/folder/share changes during an
		// editing session must not turn an old signed URL into lasting authority.
		current, ok, err := resolve(c, previous.ID)
		if !ok || !current.Writable || current.ObjectKey != previous.ObjectKey {
			return false, err
		}
		identity := auth.MustIdentity(c.Request().Context())
		return h.repo.ReplaceFileContent(c.Request().Context(), File{TenantID: identity.TenantID, ObjectKey: key, Mime: previous.Mime, Size: size, BaseModel: model.BaseModel{ID: previous.ID}}, previous.ObjectKey)
	}}
}

func (h *Handler) OfficeAttachments(active func(string) bool) office.Source {
	return office.Source{Resolve: func(c *echo.Context, attID uuid.UUID) (office.Document, bool, error) {
		if !active("teams") {
			return office.Document{}, false, notFound(c, "attachment")
		}
		ctx := c.Request().Context()
		identity := auth.MustIdentity(ctx)
		a, err := h.repo.FindAttachment(ctx, identity.TenantID, attID)
		if errors.Is(err, orm.ErrNotFound) {
			return office.Document{}, false, notFound(c, "attachment")
		}
		if err != nil {
			return office.Document{}, false, err
		}
		message, err := h.repo.FindMessage(ctx, identity.TenantID, a.MessageID)
		if errors.Is(err, orm.ErrNotFound) {
			return office.Document{}, false, notFound(c, "attachment")
		}
		if err != nil {
			return office.Document{}, false, err
		}
		if _, role, _, err := h.channelAccess(c, message.ChannelID); role == "" {
			return office.Document{}, false, err
		}
		return office.Document{ID: a.ID, Name: a.Filename, Mime: a.Mime, ObjectKey: a.ObjectKey, Size: a.Size}, true, nil
	}}
}

func fileVersion(key string) string { return fmt.Sprintf("\"%s\"", office.Version(key)) }
