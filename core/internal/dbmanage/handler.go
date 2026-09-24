package dbmanage

import (
	"net/http"

	"github.com/labstack/echo/v4"
)

// Handler wires Manager's operations into Echo. Every method calls
// RequireMasterKey first — the group this mounts under (main.go) carries no
// jwtMw/permMw at all, so this is the ONLY gate, and it must be on every
// single handler, not just the group.
type Handler struct {
	mgr *Manager
}

func NewHandler(mgr *Manager) *Handler {
	return &Handler{mgr: mgr}
}

// List handles GET /api/v1/database-management/databases.
func (h *Handler) List(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	dbs, err := ListDatabases(c.Request().Context(), h.mgr.conn, h.mgr.ActiveName())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, dbs)
}

// createRequest is the POST /databases body.
type createRequest struct {
	Name string `json:"name"`
}

// Create handles POST /api/v1/database-management/databases.
func (h *Handler) Create(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	var req createRequest
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if err := validateName(req.Name); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	}
	if err := h.mgr.CreateAndProvision(c.Request().Context(), req.Name); err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, map[string]any{"name": req.Name})
}

// Switch handles POST /api/v1/database-management/databases/:name/switch.
func (h *Handler) Switch(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	name := c.Param("name")
	if err := h.mgr.SwitchTo(c.Request().Context(), name); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"name": name, "active": true})
}

// Delete handles DELETE /api/v1/database-management/databases/:name.
func (h *Handler) Delete(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	name := c.Param("name")
	if err := DropDatabase(c.Request().Context(), h.mgr.conn, name, h.mgr.ActiveName()); err != nil {
		return errorJSON(c, http.StatusConflict, "CONFLICT", err.Error())
	}
	return c.NoContent(http.StatusNoContent)
}

// Extract handles GET /api/v1/database-management/databases/:name/extract?include_s3=true|false.
func (h *Handler) Extract(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	name := c.Param("name")
	includeS3 := c.QueryParam("include_s3") == "true"
	return h.mgr.Extract(c, name, includeS3)
}

// Restore handles POST /api/v1/database-management/databases/restore. No
// :name path segment — unlike every other action here, restore creates a NEW
// database, named by the "name" multipart form field alongside the "file"
// upload, rather than acting on an existing one a path could name.
func (h *Handler) Restore(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	return h.mgr.Restore(c)
}
