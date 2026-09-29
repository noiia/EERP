package website

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type meStore interface {
	FindByID(ctx context.Context, id uuid.UUID) (auth.Users, error)
	UpdateWebsiteProfile(ctx context.Context, tenantID, id uuid.UUID, p auth.WebsiteProfile) error
}

// MeHandler serves a website user's own profile, behind WebsiteJWTMiddleware.
type MeHandler struct{ users meStore }

func NewMeHandler(users meStore) *MeHandler { return &MeHandler{users: users} }

// Get handles GET /api/v1/website/me.
func (h *MeHandler) Get(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	u, err := h.users.FindByID(c.Request().Context(), id.UserID)
	if errors.Is(err, orm.ErrNotFound) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{
		"email": u.Email, "name": u.Name, "surname": u.Surname, "phone": u.Phone,
		"email_verified": u.EmailVerifiedAt != nil,
	})
}

// Put handles PUT /api/v1/website/me.
func (h *MeHandler) Put(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	var p auth.WebsiteProfile
	if err := c.Bind(&p); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := validProfile(&p); err != nil {
		return err
	}
	err := h.users.UpdateWebsiteProfile(c.Request().Context(), id.TenantID, id.UserID, p)
	if errors.Is(err, orm.ErrNotFound) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func validProfile(p *auth.WebsiteProfile) error {
	p.Name, p.Surname, p.Phone = strings.TrimSpace(p.Name), strings.TrimSpace(p.Surname), strings.TrimSpace(p.Phone)
	if p.Name == "" || len(p.Name) > 200 || len(p.Surname) > 200 || len(p.Phone) > 50 {
		return echo.NewHTTPError(http.StatusBadRequest, "name is required; name/surname max 200, phone max 50 characters")
	}
	return nil
}
