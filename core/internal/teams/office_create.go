package teams

import (
	"bytes"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"core/internal/auth"
	"core/internal/office"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

func (h *Handler) CreateOfficeDocument(c *echo.Context) error {
	team, role, err := h.access(c, CanWrite)
	if role == "" {
		return err
	}
	var body struct {
		Name     string `json:"name"`
		Kind     string `json:"kind"`
		FolderID string `json:"folder_id"`
	}
	if err := c.Bind(&body); err != nil {
		return invalid(c, "Malformed request body.")
	}
	data, mime, err := office.Blank(body.Kind)
	if err != nil {
		return invalid(c, "Choose a document, spreadsheet or presentation.")
	}
	name := strings.TrimSpace(body.Name)
	if strings.ContainsAny(name, "/\\") {
		return badName(c)
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx", ".xlsx", ".pptx":
		name = strings.TrimSuffix(name, filepath.Ext(name))
	}
	if name == "" {
		return badName(c)
	}
	name += "." + body.Kind
	if _, err := validName(name); err != nil {
		return badName(c)
	}
	identity := auth.MustIdentity(c.Request().Context())
	folder, ok, err := h.targetFolder(c, identity.TenantID, team, role, body.FolderID)
	if err != nil {
		return err
	}
	if !ok {
		return invalid(c, "folder_id is not a folder of this team.")
	}
	key := fmt.Sprintf("%s/teams/%s", identity.TenantID, uuid.New())
	ctx := c.Request().Context()
	if err := h.objects.Put(ctx, key, mime, int64(len(data)), bytes.NewReader(data)); err != nil {
		return err
	}
	file, err := h.repo.CreateFile(ctx, File{TenantID: identity.TenantID, TeamID: team, FolderID: folder, Name: name, Mime: mime, Size: int64(len(data)), ObjectKey: key, UploadedBy: identity.UserID})
	if err != nil {
		h.deleteObjects(ctx, []string{key}, "failed document creation")
		return err
	}
	users, err := h.userMap(ctx, identity.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, h.toFileJSON(file, users, 0))
}
