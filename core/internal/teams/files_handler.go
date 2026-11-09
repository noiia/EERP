package teams

import (
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"net/http"
	"time"

	"core/internal/auth"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

type folderJSON struct {
	ID        uuid.UUID  `json:"id"`
	Name      string     `json:"name"`
	ParentID  *uuid.UUID `json:"parent_id"`
	CreatedBy uuid.UUID  `json:"created_by"`
}

type crumbJSON struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type fileJSON struct {
	ID             uuid.UUID  `json:"id"`
	Name           string     `json:"name"`
	FolderID       *uuid.UUID `json:"folder_id"`
	Mime           string     `json:"mime"`
	Size           int64      `json:"size"`
	UploadedBy     uuid.UUID  `json:"uploaded_by"`
	UploadedByName string     `json:"uploaded_by_name"`
	CreatedAt      time.Time  `json:"created_at"`
	SharedWith     int        `json:"shared_with"`
}

func toFolderJSON(f Folder) folderJSON { return folderJSON{f.ID, f.Name, f.ParentID, f.CreatedBy} }

func (h *Handler) toFileJSON(f File, users map[uuid.UUID]auth.Users, shared int) fileJSON {
	return fileJSON{f.ID, f.Name, f.FolderID, f.Mime, f.Size, f.UploadedBy, displayName(users[f.UploadedBy]), f.CreatedAt, shared}
}

func invalid(c *echo.Context, msg string) error {
	return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", msg)
}

// targetFolder resolves a folder id from a request body: "" is the root (nil).
// ok is false when the id isn't a folder of team the caller (holding role) can see.
func (h *Handler) targetFolder(c *echo.Context, tenant, team uuid.UUID, role, s string) (folder *uuid.UUID, ok bool, err error) {
	if s == "" {
		return nil, true, nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return nil, false, nil
	}
	f, err := h.repo.FindFolder(c.Request().Context(), tenant, id)
	if errors.Is(err, orm.ErrNotFound) || (err == nil && f.TeamID != team) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if ok, err = h.folderVisible(c, tenant, team, auth.MustIdentity(c.Request().Context()).UserID, role, &f.ID); !ok {
		return nil, false, err
	}
	return &f.ID, true, nil
}

// teamFolder resolves the :folder param of the :id team (404 when absent or
// hidden from the caller; the response is then written and ok false).
func (h *Handler) teamFolder(c *echo.Context, tenant, team uuid.UUID, role string) (Folder, bool, error) {
	id, err := echo.PathParam[uuid.UUID](c, "folder")
	if err != nil {
		return Folder{}, false, notFound(c, "folder")
	}
	_, ok, err := h.targetFolder(c, tenant, team, role, id.String())
	if err != nil || !ok {
		if err == nil {
			err = notFound(c, "folder")
		}
		return Folder{}, false, err
	}
	f, err := h.repo.FindFolder(c.Request().Context(), tenant, id)
	return f, err == nil, err
}

// ListFiles serves GET /:id/files?folder=: one folder's content with its breadcrumb path.
func (h *Handler) ListFiles(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	out := map[string]any{"folder": nil, "path": []crumbJSON{}}
	folder, ok, err := h.targetFolder(c, id.TenantID, team, role, c.QueryParam("folder"))
	if err != nil {
		return err
	}
	if !ok {
		return notFound(c, "folder")
	}
	if folder != nil {
		chain, err := h.repo.Ancestors(ctx, id.TenantID, *folder)
		if err != nil {
			return err
		}
		path := make([]crumbJSON, len(chain))
		for i, f := range chain {
			path[len(chain)-1-i] = crumbJSON{f.ID, f.Name}
		}
		out["folder"] = map[string]any{"id": chain[0].ID, "name": chain[0].Name, "parent_id": chain[0].ParentID}
		out["path"] = path
	}
	all, files, err := h.repo.ListFolder(ctx, id.TenantID, team, folder)
	if err != nil {
		return err
	}
	// shortcut: one visibility walk per subfolder; batch it if folders with many subfolders get slow.
	folders := make([]Folder, 0, len(all))
	for _, f := range all {
		ok, err := h.folderVisible(c, id.TenantID, team, id.UserID, role, &f.ID)
		if err != nil {
			return err
		}
		if ok {
			folders = append(folders, f)
		}
	}
	ids := make([]uuid.UUID, len(files))
	for i, f := range files {
		ids[i] = f.ID
	}
	counts, err := h.repo.ShareCounts(ctx, id.TenantID, ids)
	if err != nil {
		return err
	}
	users, err := h.userMap(ctx, id.TenantID)
	if err != nil {
		return err
	}
	fj := make([]folderJSON, len(folders))
	for i, f := range folders {
		fj[i] = toFolderJSON(f)
	}
	files2 := make([]fileJSON, len(files))
	for i, f := range files {
		files2[i] = h.toFileJSON(f, users, counts[f.ID])
	}
	out["folders"], out["files"] = fj, files2
	return c.JSON(http.StatusOK, out)
}

// CreateFolder serves POST /:id/folders {name, parent_id?}.
func (h *Handler) CreateFolder(c *echo.Context) error {
	team, role, err := h.access(c, CanWrite)
	if role == "" {
		return err
	}
	var b struct {
		Name     string `json:"name"`
		ParentID string `json:"parent_id"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	parent, ok, err := h.targetFolder(c, id.TenantID, team, role, b.ParentID)
	if err != nil {
		return err
	}
	if !ok {
		return invalid(c, "parent_id is not a folder of this team.")
	}
	f, err := h.repo.CreateFolder(ctx, Folder{TenantID: id.TenantID, TeamID: team, ParentID: parent, Name: b.Name, CreatedBy: id.UserID})
	if errors.Is(err, ErrInvalidName) {
		return badName(c)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, toFolderJSON(f))
}

// UpdateFolder serves PUT /:id/folders/:folder {name?, parent_id?}: rename and/or move.
func (h *Handler) UpdateFolder(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	f, ok, err := h.teamFolder(c, id.TenantID, team, role)
	if !ok {
		return err
	}
	if !CanEditItem(role, f.CreatedBy, id.UserID) {
		return forbidden(c)
	}
	var b struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if b.Name != nil {
		f.Name = *b.Name
	}
	if b.ParentID != nil {
		parent, ok, err := h.targetFolder(c, id.TenantID, team, role, *b.ParentID)
		if err != nil {
			return err
		}
		if !ok {
			return invalid(c, "parent_id is not a folder of this team.")
		}
		if parent != nil {
			chain, err := h.repo.Ancestors(ctx, id.TenantID, *parent)
			if err != nil {
				return err
			}
			for _, a := range chain {
				if a.ID == f.ID {
					return invalid(c, "A folder can't move into itself or one of its subfolders.")
				}
			}
		}
		f.ParentID = parent
	}
	f, err = h.repo.UpdateFolder(ctx, f)
	if errors.Is(err, ErrInvalidName) {
		return badName(c)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, toFolderJSON(f))
}

// DeleteFolder serves DELETE /:id/folders/:folder: the whole subtree, then its objects.
func (h *Handler) DeleteFolder(c *echo.Context) error {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	f, ok, err := h.teamFolder(c, id.TenantID, team, role)
	if !ok {
		return err
	}
	if !CanEditItem(role, f.CreatedBy, id.UserID) {
		return forbidden(c)
	}
	keys, err := h.repo.DeleteFolderTree(ctx, id.TenantID, f.ID)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "folder")
	}
	if err != nil {
		return err
	}
	h.deleteObjects(ctx, keys, "folder delete")
	return c.NoContent(http.StatusNoContent)
}

// UploadFile serves POST /:id/files, multipart `file` with an optional `folder_id`.
func (h *Handler) UploadFile(c *echo.Context) error {
	team, role, err := h.access(c, CanWrite)
	if role == "" {
		return err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	fh, err := c.FormFile("file")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "A multipart file field is required.")
	}
	if _, err := validName(fh.Filename); err != nil {
		return badName(c)
	}
	folder, ok, err := h.targetFolder(c, id.TenantID, team, role, c.FormValue("folder_id"))
	if err != nil {
		return err
	}
	if !ok {
		return invalid(c, "folder_id is not a folder of this team.")
	}
	stored, err := h.storeFiles(ctx, id.TenantID, []*multipart.FileHeader{fh})
	if err != nil {
		return err
	}
	a := stored[0]
	f, err := h.repo.CreateFile(ctx, File{TenantID: id.TenantID, TeamID: team, FolderID: folder, Name: a.Filename,
		Mime: a.Mime, Size: a.Size, ObjectKey: a.ObjectKey, UploadedBy: id.UserID})
	if err != nil {
		h.deleteObjects(ctx, []string{a.ObjectKey}, "failed file insert")
		return err
	}
	users, err := h.userMap(ctx, id.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, h.toFileJSON(f, users, 0))
}

// teamFile resolves the :file param of the :id team (404 when its folder is
// hidden from the caller) and checks CanEditItem.
func (h *Handler) teamFile(c *echo.Context) (File, string, bool, error) {
	team, role, err := h.access(c, CanRead)
	if role == "" {
		return File{}, "", false, err
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	fid, err := echo.PathParam[uuid.UUID](c, "file")
	if err != nil {
		return File{}, "", false, notFound(c, "file")
	}
	f, err := h.repo.FindFile(ctx, id.TenantID, fid)
	if errors.Is(err, orm.ErrNotFound) || (err == nil && f.TeamID != team) {
		return File{}, "", false, notFound(c, "file")
	}
	if err != nil {
		return File{}, "", false, err
	}
	if ok, err := h.folderVisible(c, id.TenantID, team, id.UserID, role, f.FolderID); err != nil || !ok {
		if err == nil {
			err = notFound(c, "file")
		}
		return File{}, "", false, err
	}
	if !CanEditItem(role, f.UploadedBy, id.UserID) {
		return File{}, "", false, forbidden(c)
	}
	return f, role, true, nil
}

// UpdateFile serves PUT /:id/files/:file {name?, folder_id?}: rename and/or move.
func (h *Handler) UpdateFile(c *echo.Context) error {
	f, role, ok, err := h.teamFile(c)
	if !ok {
		return err
	}
	var b struct {
		Name     *string `json:"name"`
		FolderID *string `json:"folder_id"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	if b.Name != nil {
		f.Name = *b.Name
	}
	if b.FolderID != nil {
		folder, ok, err := h.targetFolder(c, id.TenantID, f.TeamID, role, *b.FolderID)
		if err != nil {
			return err
		}
		if !ok {
			return invalid(c, "folder_id is not a folder of this team.")
		}
		f.FolderID = folder
	}
	f, err = h.repo.UpdateFile(ctx, f)
	if errors.Is(err, ErrInvalidName) {
		return badName(c)
	}
	if err != nil {
		return err
	}
	counts, err := h.repo.ShareCounts(ctx, id.TenantID, []uuid.UUID{f.ID})
	if err != nil {
		return err
	}
	users, err := h.userMap(ctx, id.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, h.toFileJSON(f, users, counts[f.ID]))
}

// DeleteFile serves DELETE /:id/files/:file.
func (h *Handler) DeleteFile(c *echo.Context) error {
	f, _, ok, err := h.teamFile(c)
	if !ok {
		return err
	}
	ctx := c.Request().Context()
	key, err := h.repo.DeleteFile(ctx, f.TenantID, f.ID)
	if errors.Is(err, orm.ErrNotFound) {
		return notFound(c, "file")
	}
	if err != nil {
		return err
	}
	h.deleteObjects(ctx, []string{key}, "file delete")
	return c.NoContent(http.StatusNoContent)
}

// fileRole resolves the :file param and the caller's role in its team; a
// non-member, or a member its folder is hidden from, gets a 404 unless shared is
// set and the file is shared with them (role is then ""). ok false means the response is written.
func (h *Handler) fileRole(c *echo.Context, shared bool) (f File, role string, ok bool, err error) {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	fid, err := echo.PathParam[uuid.UUID](c, "file")
	if err != nil {
		return File{}, "", false, notFound(c, "file")
	}
	if f, err = h.repo.FindFile(ctx, id.TenantID, fid); errors.Is(err, orm.ErrNotFound) {
		return File{}, "", false, notFound(c, "file")
	} else if err != nil {
		return File{}, "", false, err
	}
	role, err = h.repo.RoleOf(ctx, id.TenantID, f.TeamID, id.UserID)
	if err == nil {
		visible, err := h.folderVisible(c, id.TenantID, f.TeamID, id.UserID, role, f.FolderID)
		if err != nil {
			return File{}, "", false, err
		}
		if visible {
			return f, role, true, nil
		}
	} else if !errors.Is(err, orm.ErrNotFound) {
		return File{}, "", false, err
	}
	if shared {
		is, err := h.repo.IsSharedWith(ctx, id.TenantID, f.ID, id.UserID)
		if err != nil {
			return File{}, "", false, err
		}
		if is {
			return f, "", true, nil
		}
	}
	return File{}, "", false, notFound(c, "file")
}

// DownloadFile serves GET /files/:file/download to the team's readers and the file's recipients.
func (h *Handler) DownloadFile(c *echo.Context) error {
	f, _, ok, err := h.fileRole(c, true)
	if !ok {
		return err
	}
	body, contentType, err := h.objects.Get(c.Request().Context(), f.ObjectKey)
	if err != nil {
		return fmt.Errorf("teams: read object: %w", err)
	}
	defer func() { _ = body.Close() }()
	if f.Mime != "" {
		contentType = f.Mime
	}
	c.Response().Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	return c.Stream(http.StatusOK, contentType, body)
}

type shareJSON struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
}

func (h *Handler) shares(c *echo.Context, f File) error {
	ctx := c.Request().Context()
	ids, err := h.repo.Recipients(ctx, f.TenantID, f.ID)
	if err != nil {
		return err
	}
	users, err := h.userMap(ctx, f.TenantID)
	if err != nil {
		return err
	}
	out := make([]shareJSON, len(ids))
	for i, u := range ids {
		out[i] = shareJSON{u, displayName(users[u]), users[u].Email}
	}
	return list(c, out)
}

// GetShares serves GET /files/:file/shares to the file's team readers.
func (h *Handler) GetShares(c *echo.Context) error {
	f, _, ok, err := h.fileRole(c, false)
	if !ok {
		return err
	}
	return h.shares(c, f)
}

// PutShares serves PUT /files/:file/shares {user_ids}: replaces the recipients (staff of the tenant only).
func (h *Handler) PutShares(c *echo.Context) error {
	f, role, ok, err := h.fileRole(c, false)
	if !ok {
		return err
	}
	// same rule as rename/delete: an owner shares any file, a member only their own uploads
	if !CanEditItem(role, f.UploadedBy, auth.MustIdentity(c.Request().Context()).UserID) {
		return forbidden(c)
	}
	var b struct {
		UserIDs []uuid.UUID `json:"user_ids"`
	}
	if err := c.Bind(&b); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	users, err := h.userMap(ctx, f.TenantID)
	if err != nil {
		return err
	}
	for _, u := range b.UserIDs {
		if _, ok := users[u]; !ok {
			return invalid(c, "user_ids must be staff users of this workspace.")
		}
	}
	if err := h.repo.SetRecipients(ctx, f.TenantID, f.ID, b.UserIDs); err != nil {
		return err
	}
	return h.shares(c, f)
}

type sharedJSON struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	Mime         string    `json:"mime"`
	Size         int64     `json:"size"`
	TeamID       uuid.UUID `json:"team_id"`
	TeamName     string    `json:"team_name"`
	SharedByName string    `json:"shared_by_name"`
	CreatedAt    time.Time `json:"created_at"`
}

// ListShared serves GET /shared: the files shared with the caller.
func (h *Handler) ListShared(c *echo.Context) error {
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	rows, err := h.repo.SharedWith(ctx, id.TenantID, id.UserID)
	if err != nil {
		return err
	}
	users, err := h.userMap(ctx, id.TenantID)
	if err != nil {
		return err
	}
	out := make([]sharedJSON, len(rows))
	for i, s := range rows {
		// shortcut: shares record no sharer, so the uploader stands in; add team_file_share.shared_by if users need the real sharer.
		out[i] = sharedJSON{s.File.ID, s.File.Name, s.File.Mime, s.File.Size, s.File.TeamID, s.TeamName,
			displayName(users[s.File.UploadedBy]), s.SharedAt}
	}
	return list(c, out)
}
