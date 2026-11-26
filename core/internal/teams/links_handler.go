package teams

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// MaxLinkLifetime caps a download link's expiry.
const MaxLinkLifetime = 90 * 24 * time.Hour

type linkJSON struct {
	ID             uuid.UUID  `json:"id"`
	Token          string     `json:"token,omitempty"` // only in the create answer
	URL            string     `json:"url,omitempty"`
	ExpiresAt      time.Time  `json:"expires_at"`
	CreatedByName  string     `json:"created_by_name"`
	CreatedAt      time.Time  `json:"created_at"`
	DownloadCount  int        `json:"download_count"`
	LastDownloadAt *time.Time `json:"last_download_at"`
	Public         bool       `json:"public"`
}

// linkManager resolves the file and applies the share rule (an owner, or the
// uploading member). ok false means the response is written.
func (h *Handler) linkManager(c *echo.Context, fid uuid.UUID) (File, bool, error) {
	f, role, ok, err := h.fileRoleByID(c, false, fid)
	if !ok {
		return File{}, false, err
	}
	if !CanEditItem(role, f.UploadedBy, auth.MustIdentity(c.Request().Context()).UserID) {
		return File{}, false, forbidden(c)
	}
	return f, true, nil
}

func toLinkJSON(l Link, users map[uuid.UUID]auth.Users) linkJSON {
	return linkJSON{ID: l.ID, ExpiresAt: l.ExpiresAt, CreatedByName: displayName(users[l.CreatedBy]),
		CreatedAt: l.CreatedAt, DownloadCount: l.DownloadCount, LastDownloadAt: l.LastDownloadAt, Public: l.Public}
}

// ListLinks serves GET /files/:file/links: the file's live links, to its managers.
func (h *Handler) ListLinks(c *echo.Context) error {
	fid, err := echo.PathParam[uuid.UUID](c, "file")
	if err != nil {
		return notFound(c, "file")
	}
	f, ok, err := h.linkManager(c, fid)
	if !ok {
		return err
	}
	ctx := c.Request().Context()
	links, err := h.repo.ListLinks(ctx, f.TenantID, f.ID)
	if err != nil {
		return err
	}
	users, err := h.userMap(ctx, f.TenantID)
	if err != nil {
		return err
	}
	out := make([]linkJSON, len(links))
	for i, l := range links {
		out[i] = toLinkJSON(l, users)
	}
	return list(c, out)
}

// CreateLink serves POST /files/:file/links {expires_at}: the token is returned
// this once and only its hash is kept.
func (h *Handler) CreateLink(c *echo.Context) error {
	fid, err := echo.PathParam[uuid.UUID](c, "file")
	if err != nil {
		return notFound(c, "file")
	}
	f, ok, err := h.linkManager(c, fid)
	if !ok {
		return err
	}
	var b struct {
		ExpiresAt time.Time `json:"expires_at"`
		Public    bool      `json:"public"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if now := time.Now(); !b.ExpiresAt.After(now) || b.ExpiresAt.After(now.Add(MaxLinkLifetime)) {
		return invalid(c, "expires_at must be in the future and at most 90 days away.")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	l, err := h.repo.CreateLink(c.Request().Context(), Link{TenantID: f.TenantID, TeamID: f.TeamID, FileID: f.ID,
		CreatedBy: auth.MustIdentity(c.Request().Context()).UserID, TokenHash: HashToken(token), ExpiresAt: b.ExpiresAt, Public: b.Public})
	if err != nil {
		return err
	}
	users, err := h.userMap(c.Request().Context(), f.TenantID)
	if err != nil {
		return err
	}
	out := toLinkJSON(l, users)
	out.Token, out.URL = token, "/app/teams/links/"+token
	if l.Public {
		out.URL = "/api/v1/file-links/" + token
	}
	return c.JSON(http.StatusCreated, out)
}

// RevokeLink serves DELETE /files/links/:link, to the link's file managers.
func (h *Handler) RevokeLink(c *echo.Context) error {
	lid, err := echo.PathParam[uuid.UUID](c, "link")
	if err != nil {
		return notFound(c, "link")
	}
	ctx := c.Request().Context()
	l, err := h.repo.FindLink(ctx, auth.MustIdentity(ctx).TenantID, lid)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "link")
	}
	if err != nil {
		return err
	}
	if _, ok, err := h.linkManager(c, l.FileID); !ok {
		return err
	}
	if err := h.repo.RevokeLink(ctx, l.TenantID, l.ID); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// DownloadLink serves GET /links/:token/download to any staff user of the
// link's tenant. Every failure is the same 404, so a token can't be probed;
// the link also dies once its creator can no longer read the file.
func (h *Handler) DownloadLink(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	l, err := h.repo.ResolveLink(ctx, HashToken(c.Param("token")))
	if errors.Is(err, orm.ErrNotFound) || (err == nil && l.TenantID != id.TenantID) {
		return notFound(c, "file")
	}
	if err != nil {
		return err
	}
	return h.serveLink(c, l)
}

// PublicDownload serves GET /api/v1/file-links/:token to anyone, account or
// not, for links created public. Every failure is the same 404.
func (h *Handler) PublicDownload(c *echo.Context) error {
	l, err := h.repo.ResolveLink(c.Request().Context(), HashToken(c.Param("token")))
	if errors.Is(err, orm.ErrNotFound) || (err == nil && !l.Public) {
		return notFound(c, "file")
	}
	if err != nil {
		return err
	}
	return h.serveLink(c, l)
}

// serveLink streams a resolved link's file while its creator can still read it.
func (h *Handler) serveLink(c *echo.Context, l Link) error {
	ctx := c.Request().Context()
	f, err := h.repo.FindFile(ctx, l.TenantID, l.FileID)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "file")
	}
	if err != nil {
		return err
	}
	role, err := h.repo.RoleOf(ctx, l.TenantID, f.TeamID, l.CreatedBy)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "file")
	}
	if err != nil {
		return err
	}
	if visible, err := h.visibleFolder(ctx, l.TenantID, f.TeamID, l.CreatedBy, role, f.FolderID); err != nil {
		return err
	} else if !visible {
		return notFound(c, "file")
	}
	if err := h.repo.CountDownload(ctx, l.TenantID, l.ID); err != nil {
		return err
	}
	c.Response().Header().Set("Cache-Control", "private, no-store")
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	return h.streamFile(c, f)
}

// MountPublicLinks registers the anonymous public-link route. Needs S3.
func MountPublicLinks(g *echo.Group, h *Handler) {
	if h.objects == nil {
		return
	}
	g.GET("/:token", h.PublicDownload)
}

// MountLinks registers the download-link route, rate-limited by limit. Needs S3.
func MountLinks(g *echo.Group, h *Handler, limit echo.MiddlewareFunc) {
	if h.objects == nil {
		return
	}
	g.GET("/links/:token/download", h.DownloadLink, limit)
}
