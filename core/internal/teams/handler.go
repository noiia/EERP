package teams

import (
	"context"
	"errors"
	"net/http"

	"core/internal/auth"
	"core/internal/notify"
	"core/internal/pictures"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// UserLister lists the tenant's staff (no website visitors).
type UserLister interface {
	ListByTenant(ctx context.Context, tenant uuid.UUID) ([]auth.Users, error)
}

// Pusher delivers a live frame to exactly the given users.
type Pusher interface {
	SendToUsers(tenant uuid.UUID, users []uuid.UUID, payload []byte)
}

type Notifier interface {
	Personal(ctx context.Context, tenant, user uuid.UUID, m notify.Message) (notify.Notification, error)
}

// Handler serves the Teams API. Non-members always get a 404, never a 403, so
// team ids can't be probed.
type Handler struct {
	repo     *Repository
	users    UserLister
	hub      Pusher
	notifier Notifier
	objects  pictures.ObjectStore // nil without S3
}

func NewHandler(repo *Repository, users UserLister, hub Pusher, notifier Notifier, objects pictures.ObjectStore) *Handler {
	return &Handler{repo: repo, users: users, hub: hub, notifier: notifier, objects: objects}
}

func errorJSON(c *echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}

// ActiveGate 404s every Teams route while the module is deactivated.
func ActiveGate(isActive func(string) bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if !isActive("teams") {
				return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Teams is not active.")
			}
			return next(c)
		}
	}
}

// requireRole resolves the caller's role in team: a non-member gets a 404 and a
// member failing ok a 403 (both already written, role is then empty).
func (h *Handler) requireRole(c *echo.Context, team uuid.UUID, ok func(string) bool) (string, error) {
	id := auth.MustIdentity(c.Request().Context())
	role, err := h.repo.RoleOf(c.Request().Context(), id.TenantID, team, id.UserID)
	if errors.Is(err, orm.ErrNotFound) {
		return "", errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such team.")
	}
	if err != nil {
		return "", err
	}
	if !ok(role) {
		return "", errorJSON(c, http.StatusForbidden, "FORBIDDEN", "Your role does not allow this.")
	}
	return role, nil
}

// access resolves the :id team and checks the role. An empty role means a
// response was already written: return err as is.
func (h *Handler) access(c *echo.Context, ok func(string) bool) (team uuid.UUID, role string, err error) {
	team, err = echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return team, "", errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such team.")
	}
	role, err = h.requireRole(c, team, ok)
	return team, role, err
}

// Mount registers the routes. upload caps the /channels/... and /:id/files/...
// routes: those prefixes are exempt from the global request body limit since
// the message POST and the file upload carry files. File routes need S3.
func Mount(g *echo.Group, h *Handler, upload echo.MiddlewareFunc) {
	g.GET("", h.ListTeams)
	g.POST("", h.CreateTeam)
	g.GET("/directory", h.Directory)
	g.GET("/:id", h.GetTeam)
	g.PUT("/:id", h.UpdateTeam)
	g.DELETE("/:id", h.DeleteTeam)
	g.GET("/:id/members", h.ListMembers)
	g.POST("/:id/members", h.AddMember)
	g.PUT("/:id/members/:user", h.SetMemberRole)
	g.DELETE("/:id/members/:user", h.RemoveMember)
	g.GET("/:id/channels", h.ListChannels)
	g.POST("/:id/channels", h.CreateChannel)
	g.PUT("/:id/channels/order", h.SetChannelOrder)
	g.PUT("/direct/order", h.SetDirectOrder)
	g.PUT("/:id/channels/:channel", h.RenameChannel)
	g.DELETE("/:id/channels/:channel", h.DeleteChannel)
	g.GET("/:id/channels/:channel/access", h.GetChannelAccess)
	g.PUT("/:id/channels/:channel/access", h.PutChannelAccess)
	g.GET("/:id/groups", h.ListGroups)
	g.POST("/:id/groups", h.CreateGroup)
	g.PUT("/:id/groups/:group", h.UpdateGroup)
	g.DELETE("/:id/groups/:group", h.DeleteGroup)
	g.GET("/direct", h.ListDirect)
	g.POST("/direct", h.OpenDirect)
	g.GET("/channels/:channel/messages", h.ListMessages)
	g.POST("/channels/:channel/messages", h.PostMessage, upload)
	g.POST("/channels/:channel/read", h.MarkRead, upload)
	g.POST("/messages/:message/reactions", h.ToggleReaction)
	g.GET("/attachments/:id", h.GetAttachment)
	if h.objects == nil {
		return
	}
	g.GET("/:id/files", h.ListFiles)
	g.POST("/:id/files", h.UploadFile, upload)
	g.PUT("/:id/files/:file", h.UpdateFile, upload)
	g.DELETE("/:id/files/:file", h.DeleteFile)
	g.POST("/:id/folders", h.CreateFolder)
	g.PUT("/:id/folders/:folder", h.UpdateFolder)
	g.DELETE("/:id/folders/:folder", h.DeleteFolder)
	g.GET("/files/:file/download", h.DownloadFile)
	g.GET("/files/:file/shares", h.GetShares)
	g.PUT("/files/:file/shares", h.PutShares)
	g.GET("/shared", h.ListShared)
}
