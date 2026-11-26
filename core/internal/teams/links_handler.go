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
		CreatedAt: l.CreatedAt, DownloadCount: l.DownloadCount, LastDownloadAt: l.LastDownloadAt}
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
		CreatedBy: auth.MustIdentity(c.Request().Context()).UserID, TokenHash: HashToken(token), ExpiresAt: b.ExpiresAt})
	if err != nil {
		return err
	}
	users, err := h.userMap(c.Request().Context(), f.TenantID)
	if err != nil {
		return err
	}
	out := toLinkJSON(l, users)
	out.Token, out.URL = token, "/app/teams/links/"+token
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
