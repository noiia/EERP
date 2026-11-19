package pictures

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// avatarUsers resolves a staff user of the caller's tenant (website users and
// other tenants read as orm.ErrNotFound).
type avatarUsers interface {
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (auth.Users, error)
}

// AvatarHandler serves GET /api/v1/avatars/:user — the (users, <user>, avatar)
// picture, e.g. an LDAP-synced photo. JWT only: any staff user may see a
// colleague's avatar, never across tenants.
type AvatarHandler struct {
	repo    *Repository
	objects ObjectStore
	users   avatarUsers
}

func NewAvatarHandler(repo *Repository, objects ObjectStore, users avatarUsers) *AvatarHandler {
	return &AvatarHandler{repo: repo, objects: objects, users: users}
}

func (h *AvatarHandler) Get(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	id, err := echo.PathParam[uuid.UUID](c, "user")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "user must be a UUID.")
	}
	if _, err := h.users.FindInTenant(ctx, tenant, id); err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such avatar.")
		}
		return err
	}
	p, err := h.repo.FindByAnchor(ctx, tenant, "users", id, "avatar")
	if errors.Is(err, orm.ErrNotFound) {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such avatar.")
	}
	if err != nil {
		return err
	}
	body, ctype, err := h.objects.Get(ctx, p.ObjectKey)
	if err != nil {
		return fmt.Errorf("avatars: get object: %w", err)
	}
	defer func() { _ = body.Close() }()
	if p.Mime != "" {
		ctype = p.Mime
	}
	c.Response().Header().Set("Cache-Control", "private, max-age=300")
	return c.Stream(http.StatusOK, ctype, body)
}
