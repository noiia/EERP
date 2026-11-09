package teams

import (
	"errors"
	"net/http"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type groupBody struct {
	Name    string      `json:"name"`
	UserIDs []uuid.UUID `json:"user_ids"`
}

type accessBody struct {
	UserIDs  []uuid.UUID `json:"user_ids"`
	GroupIDs []uuid.UUID `json:"group_ids"`
}

// ListGroups serves GET /:id/groups (owners).
func (h *Handler) ListGroups(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	gs, err := h.repo.ListGroups(c.Request().Context(), auth.MustIdentity(c.Request().Context()).TenantID, team)
	if err != nil {
		return err
	}
	return list(c, gs)
}

func (h *Handler) CreateGroup(c *echo.Context) error { return h.saveGroup(c, false) }
func (h *Handler) UpdateGroup(c *echo.Context) error { return h.saveGroup(c, true) }

// saveGroup serves POST /:id/groups and PUT /:id/groups/:group {name, user_ids} (owners).
func (h *Handler) saveGroup(c *echo.Context, update bool) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	var gid *uuid.UUID
	if update {
		g, err := echo.PathParam[uuid.UUID](c, "group")
		if err != nil {
			return notFound(c, "group")
		}
		gid = &g
	}
	var b groupBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	g, err := h.repo.SaveGroup(ctx, auth.MustIdentity(ctx).TenantID, team, gid, b.Name, b.UserIDs)
	switch {
	case errors.Is(err, ErrInvalidName):
		return badName(c)
	case errors.Is(err, ErrOutsideTeam):
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "user_ids must be members of this team.")
	case errors.Is(err, ErrGroupExists):
		return errorJSON(c, http.StatusConflict, "CONFLICT", "A group with this name already exists.")
	case errors.Is(err, orm.ErrNotFound):
		return notFound(c, "group")
	case err != nil:
		return err
	}
	if update {
		return c.JSON(http.StatusOK, g)
	}
	return c.JSON(http.StatusCreated, g)
}

// DeleteGroup serves DELETE /:id/groups/:group (owners): its access entries go with it.
func (h *Handler) DeleteGroup(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	g, err := echo.PathParam[uuid.UUID](c, "group")
	if err != nil {
		return notFound(c, "group")
	}
	ctx := c.Request().Context()
	err = h.repo.DeleteGroup(ctx, auth.MustIdentity(ctx).TenantID, team, g)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "group")
	}
	if err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// accessChannel resolves the :channel of the :id team for an owner; a written response leaves ok false.
func (h *Handler) accessChannel(c *echo.Context) (team, channel uuid.UUID, ok bool, err error) {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return team, channel, false, err
	}
	if channel, err = h.channelParam(c); err != nil {
		return team, channel, false, err
	}
	ctx := c.Request().Context()
	_, err = h.repo.findChannel(ctx, auth.MustIdentity(ctx).TenantID, team, channel)
	if errors.Is(err, orm.ErrNotFound) {
		return team, channel, false, notFound(c, "channel")
	}
	return team, channel, err == nil, err
}

func (h *Handler) writeAccess(c *echo.Context, channel uuid.UUID) error {
	ctx := c.Request().Context()
	users, groups, err := h.repo.AccessList(ctx, auth.MustIdentity(ctx).TenantID, channel)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, accessBody{users, groups})
}

// GetChannelAccess serves GET /:id/channels/:channel/access (owners).
func (h *Handler) GetChannelAccess(c *echo.Context) error {
	_, channel, ok, err := h.accessChannel(c)
	if !ok {
		return err
	}
	return h.writeAccess(c, channel)
}

// PutChannelAccess serves PUT /:id/channels/:channel/access {user_ids, group_ids} (owners):
// replaces the whole list, an empty one opens the channel to the whole team.
func (h *Handler) PutChannelAccess(c *echo.Context) error {
	team, channel, ok, err := h.accessChannel(c)
	if !ok {
		return err
	}
	var b accessBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	err = h.repo.SetAccessList(ctx, auth.MustIdentity(ctx).TenantID, team, channel, b.UserIDs, b.GroupIDs)
	if errors.Is(err, ErrOutsideTeam) {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "user_ids and group_ids must belong to this team.")
	}
	if err != nil {
		return err
	}
	return h.writeAccess(c, channel)
}
