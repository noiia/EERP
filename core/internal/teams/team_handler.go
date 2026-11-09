package teams

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"

	"core/internal/auth"
	"core/internal/common"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"go.uber.org/zap"
)

type teamJSON struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Role        string    `json:"role"`
	MemberCount int       `json:"member_count"`
	Unread      int       `json:"unread"`
}

func toTeamJSON(s TeamSummary) teamJSON {
	return teamJSON{s.ID, s.Name, s.Description, s.Role, s.MemberCount, s.Unread}
}

type listJSON[T any] struct {
	Data  []T `json:"data"`
	Total int `json:"total"`
}

func list[T any](c *echo.Context, rows []T) error {
	if rows == nil {
		rows = []T{}
	}
	return c.JSON(http.StatusOK, listJSON[T]{rows, len(rows)})
}

// deleteObjects removes stored objects best-effort: an orphan is a storage leak, not an integrity bug.
func (h *Handler) deleteObjects(ctx context.Context, keys []string, after string) {
	if h.objects == nil {
		return
	}
	for _, k := range keys {
		if err := h.objects.Delete(ctx, k); err != nil && common.Logger != nil {
			common.Logger.Warn("teams: orphaned object after "+after, zap.String("key", k), zap.Error(err))
		}
	}
}

func badName(c *echo.Context) error {
	return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Name must be 1-200 characters.")
}

// summary re-reads one team the caller belongs to.
func (h *Handler) summary(c *echo.Context, team uuid.UUID) (TeamSummary, error) {
	id := auth.MustIdentity(c.Request().Context())
	all, err := h.repo.ListMyTeams(c.Request().Context(), id.TenantID, id.UserID)
	if err != nil {
		return TeamSummary{}, err
	}
	for _, s := range all {
		if s.ID == team {
			return s, nil
		}
	}
	return TeamSummary{}, orm.ErrNotFound
}

func (h *Handler) ListTeams(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	all, err := h.repo.ListMyTeams(c.Request().Context(), id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	out := make([]teamJSON, len(all))
	for i, s := range all {
		out[i] = toTeamJSON(s)
	}
	return list(c, out)
}

type teamBody struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (h *Handler) CreateTeam(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	var b teamBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	t, _, err := h.repo.CreateTeam(c.Request().Context(), Team{TenantID: id.TenantID, Name: b.Name, Description: b.Description}, id.UserID)
	if errors.Is(err, ErrInvalidName) {
		return badName(c)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, teamJSON{ID: t.ID, Name: t.Name, Description: t.Description, Role: RoleOwner, MemberCount: 1})
}

func (h *Handler) GetTeam(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	s, err := h.summary(c, team)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, toTeamJSON(s))
}

func (h *Handler) UpdateTeam(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	var b teamBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if _, err := h.repo.UpdateTeam(c.Request().Context(), auth.MustIdentity(c.Request().Context()).TenantID, team, b.Name, b.Description); err != nil {
		if errors.Is(err, ErrInvalidName) {
			return badName(c)
		}
		return err
	}
	s, err := h.summary(c, team)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, toTeamJSON(s))
}

func (h *Handler) DeleteTeam(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	keys, err := h.repo.DeleteTeam(ctx, auth.MustIdentity(ctx).TenantID, team)
	if err != nil {
		return err
	}
	h.deleteObjects(ctx, keys, "team delete")
	return c.NoContent(http.StatusNoContent)
}

type memberJSON struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
	Role        string    `json:"role"`
	HasAvatar   bool      `json:"has_avatar"`
}

type directoryJSON struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
	HasAvatar   bool      `json:"has_avatar"`
}

func hasAvatar(u auth.Users) bool { return u.Avatar != nil && *u.Avatar }

func displayName(u auth.Users) string {
	if n := strings.TrimSpace(u.DisplayName); n != "" {
		return n
	}
	return u.Email
}

// Directory lists the tenant's staff, for member and direct-message pickers.
func (h *Handler) Directory(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	us, err := h.users.ListByTenant(c.Request().Context(), id.TenantID)
	if err != nil {
		return err
	}
	out := make([]directoryJSON, len(us))
	for i, u := range us {
		out[i] = directoryJSON{u.ID, displayName(u), u.Email, hasAvatar(u)}
	}
	return list(c, out)
}

func (h *Handler) ListMembers(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	ms, err := h.repo.ListMembers(ctx, tenant, team)
	if err != nil {
		return err
	}
	us, err := h.users.ListByTenant(ctx, tenant)
	if err != nil {
		return err
	}
	byID := make(map[uuid.UUID]auth.Users, len(us))
	for _, u := range us {
		byID[u.ID] = u
	}
	out := make([]memberJSON, 0, len(ms))
	for _, m := range ms {
		u := byID[m.UserID]
		out = append(out, memberJSON{m.UserID, displayName(u), u.Email, m.Role, hasAvatar(u)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return list(c, out)
}

func validRole(r string) bool { return r == RoleOwner || r == RoleMember || r == RoleGuest }

type memberBody struct {
	UserID uuid.UUID `json:"user_id"`
	Role   string    `json:"role"`
}

func (h *Handler) AddMember(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	var b memberBody
	if err := c.Bind(&b); err != nil || !validRole(b.Role) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "user_id and a valid role are required.")
	}
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	us, err := h.users.ListByTenant(ctx, tenant)
	if err != nil {
		return err
	}
	var target *auth.Users
	for i := range us {
		if us[i].ID == b.UserID {
			target = &us[i]
		}
	}
	if target == nil {
		return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "user_id is not a staff user of this workspace.")
	}
	if _, err := h.repo.AddMember(ctx, tenant, team, b.UserID, b.Role); err != nil {
		if errors.Is(err, ErrExists) {
			return errorJSON(c, http.StatusConflict, "CONFLICT", "Already a member of this team.")
		}
		return err
	}
	return c.JSON(http.StatusCreated, memberJSON{target.ID, displayName(*target), target.Email, b.Role, hasAvatar(*target)})
}

func (h *Handler) memberUser(c *echo.Context) (uuid.UUID, error) {
	u, err := echo.PathParam[uuid.UUID](c, "user")
	if err != nil {
		return u, errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such member.")
	}
	return u, nil
}

func (h *Handler) memberResult(c *echo.Context, err error) error {
	switch {
	case errors.Is(err, ErrLastOwner):
		return errorJSON(c, http.StatusConflict, "LAST_OWNER", "A team needs at least one owner.")
	case errors.Is(err, orm.ErrNotFound):
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such member.")
	}
	return err
}

func (h *Handler) SetMemberRole(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	var b memberBody
	if err := c.Bind(&b); err != nil || !validRole(b.Role) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "A valid role is required.")
	}
	user, err := h.memberUser(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	if err := h.repo.SetRole(ctx, auth.MustIdentity(ctx).TenantID, team, user, b.Role); err != nil {
		return h.memberResult(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// RemoveMember removes a member (owner) or lets any member leave (self).
func (h *Handler) RemoveMember(c *echo.Context) error {
	user, err := h.memberUser(c)
	if err != nil {
		return err
	}
	self := auth.MustIdentity(c.Request().Context()).UserID == user
	team, role, err := h.access(c, func(r string) bool { return self || CanManage(r) })
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	if err := h.repo.RemoveMember(ctx, auth.MustIdentity(ctx).TenantID, team, user); err != nil {
		return h.memberResult(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

type channelJSON struct {
	ID     uuid.UUID `json:"id"`
	TeamID uuid.UUID `json:"team_id"`
	Kind   string    `json:"kind"`
	Name   string    `json:"name"`
	Unread int       `json:"unread"`
}

func toChannelJSON(ch Channel) channelJSON {
	var t uuid.UUID
	if ch.TeamID != nil {
		t = *ch.TeamID
	}
	return channelJSON{ch.ID, t, ch.Kind, ch.Name, 0}
}

func (h *Handler) ListChannels(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	chs, err := h.repo.ListChannelsFor(ctx, id.TenantID, team, id.UserID)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(chs))
	for i, ch := range chs {
		ids[i] = ch.ID
	}
	unread, err := h.repo.UnreadCounts(ctx, id.TenantID, id.UserID, ids)
	if err != nil {
		return err
	}
	out := make([]channelJSON, len(chs))
	for i, ch := range chs {
		out[i] = toChannelJSON(ch)
		out[i].Unread = unread[ch.ID]
	}
	return list(c, out)
}

func (h *Handler) CreateChannel(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	var b teamBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	ch, err := h.repo.CreateChannel(ctx, auth.MustIdentity(ctx).TenantID, team, b.Name)
	if errors.Is(err, ErrInvalidName) {
		return badName(c)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, toChannelJSON(ch))
}

func (h *Handler) channelParam(c *echo.Context) (uuid.UUID, error) {
	ch, err := echo.PathParam[uuid.UUID](c, "channel")
	if err != nil {
		return ch, errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such channel.")
	}
	return ch, nil
}

func (h *Handler) RenameChannel(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	var b teamBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	chID, err := h.channelParam(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	ch, err := h.repo.RenameChannel(ctx, auth.MustIdentity(ctx).TenantID, team, chID, b.Name)
	switch {
	case errors.Is(err, ErrInvalidName):
		return badName(c)
	case errors.Is(err, orm.ErrNotFound):
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such channel.")
	case err != nil:
		return err
	}
	return c.JSON(http.StatusOK, toChannelJSON(ch))
}

func (h *Handler) DeleteChannel(c *echo.Context) error {
	team, role, err := h.access(c, CanManage)
	if role == "" {
		return err
	}
	chID, err := h.channelParam(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	keys, err := h.repo.DeleteChannel(ctx, auth.MustIdentity(ctx).TenantID, team, chID)
	switch {
	case errors.Is(err, ErrLastChannel):
		return errorJSON(c, http.StatusConflict, "LAST_CHANNEL", "A team needs at least one channel.")
	case errors.Is(err, orm.ErrNotFound):
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such channel.")
	case err != nil:
		return err
	}
	h.deleteObjects(ctx, keys, "channel delete")
	return c.NoContent(http.StatusNoContent)
}

// orderBody is the PUT .../order body: the conversation ids in the caller's wanted order.
type orderBody struct {
	IDs []uuid.UUID `json:"ids"`
}

// setOrder validates body ids against the conversations the caller can see
// (visible) and stores their positions; an unknown id is a 422.
func (h *Handler) setOrder(c *echo.Context, visible []uuid.UUID) error {
	var b orderBody
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ok := make(map[uuid.UUID]bool, len(visible))
	for _, v := range visible {
		ok[v] = true
	}
	for _, i := range b.IDs {
		if !ok[i] {
			return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "ids must be conversations you can see.")
		}
	}
	id := auth.MustIdentity(c.Request().Context())
	if err := h.repo.SetOrder(c.Request().Context(), id.TenantID, id.UserID, b.IDs); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// SetChannelOrder serves PUT /:id/channels/order: the caller's own channel order in a team.
func (h *Handler) SetChannelOrder(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	id := auth.MustIdentity(c.Request().Context())
	chs, err := h.repo.ListChannels(c.Request().Context(), id.TenantID, team)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(chs))
	for i, ch := range chs {
		ids[i] = ch.ID
	}
	return h.setOrder(c, ids)
}
