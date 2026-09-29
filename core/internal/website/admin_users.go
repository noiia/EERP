package website

import (
	"context"
	"errors"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type adminStore interface {
	ListWebsiteUsers(ctx context.Context, tenantID uuid.UUID) ([]auth.Users, error)
	SetWebsiteUserDisabled(ctx context.Context, tenantID, id uuid.UUID, disabled bool) error
	UpdateWebsiteProfile(ctx context.Context, tenantID, id uuid.UUID, p auth.WebsiteProfile) error
}

type revoker interface {
	RevokeAll(ctx context.Context, userID uuid.UUID) error
}

// AdminUsersHandler is the ERP-side management of website accounts
// (/api/v1/website_admin/users, permissions website_admin:users:*).
type AdminUsersHandler struct {
	users   adminStore
	refresh revoker
}

func NewAdminUsersHandler(users adminStore, refresh revoker) *AdminUsersHandler {
	return &AdminUsersHandler{users: users, refresh: refresh}
}

type websiteUserResponse struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	Name          string    `json:"name"`
	Surname       string    `json:"surname"`
	Phone         string    `json:"phone"`
	CreatedAt     time.Time `json:"created_at"`
	Disabled      bool      `json:"disabled"`
	EmailVerified bool      `json:"email_verified"`
}

// List handles GET /api/v1/website_admin/users.
func (h *AdminUsersHandler) List(c *echo.Context) error {
	ctx := c.Request().Context()
	users, err := h.users.ListWebsiteUsers(ctx, auth.MustIdentity(ctx).TenantID)
	if err != nil {
		return err
	}
	out := make([]websiteUserResponse, 0, len(users))
	for _, u := range users {
		out = append(out, websiteUserResponse{ID: u.ID, Email: u.Email, Name: u.Name, Surname: u.Surname, Phone: u.Phone,
			CreatedAt: u.CreatedAt, Disabled: u.DeletedAt != nil, EmailVerified: u.EmailVerifiedAt != nil})
	}
	return c.JSON(http.StatusOK, out)
}

// Update handles PUT /api/v1/website_admin/users/:id — {disabled?, name?, surname?, phone?}.
// A profile edit needs a live account (re-enable first); name/surname/phone
// are only applied when at least one is present.
func (h *AdminUsersHandler) Update(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}
	var req struct {
		Disabled *bool   `json:"disabled"`
		Name     *string `json:"name"`
		Surname  *string `json:"surname"`
		Phone    *string `json:"phone"`
	}
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if req.Disabled != nil {
		err := h.users.SetWebsiteUserDisabled(ctx, tenant, id, *req.Disabled)
		switch {
		case errors.Is(err, orm.ErrNotFound):
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		case errors.Is(err, auth.ErrEmailTaken):
			return echo.NewHTTPError(http.StatusConflict, "another account now uses this email")
		case err != nil:
			return err
		}
		if *req.Disabled {
			if err := h.refresh.RevokeAll(ctx, id); err != nil {
				return err
			}
		}
	}
	if req.Name != nil || req.Surname != nil || req.Phone != nil {
		p := auth.WebsiteProfile{Name: deref(req.Name), Surname: deref(req.Surname), Phone: deref(req.Phone)}
		if err := validProfile(&p); err != nil {
			return err
		}
		err := h.users.UpdateWebsiteProfile(ctx, tenant, id, p)
		if errors.Is(err, orm.ErrNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		if err != nil {
			return err
		}
	}
	return c.NoContent(http.StatusNoContent)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
