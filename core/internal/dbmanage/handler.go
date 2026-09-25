package dbmanage

import (
	"context"
	"errors"
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

// List handles GET /api/v1/database-management/databases. Merges Manager's
// in-memory prepared-standby state onto ListDatabases' Postgres-sourced rows
// — see DatabaseInfo's own doc comment for why that merge lives here rather
// than inside ListDatabases itself.
func (h *Handler) List(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	dbs, err := ListDatabases(c.Request().Context(), h.mgr.conn, h.mgr.ActiveName())
	if err != nil {
		return err
	}
	for i := range dbs {
		info := h.mgr.PrepareInfoFor(dbs[i].Name)
		dbs[i].Status = info.Status
		dbs[i].PrepareError = info.Error
		dbs[i].ProgressDone = info.ProgressDone
		dbs[i].ProgressTotal = info.ProgressTotal
		dbs[i].ElapsedSeconds = info.ElapsedSeconds
		dbs[i].EstimatedSeconds = info.EstimatedSeconds
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

// Switch handles POST /api/v1/database-management/databases/:name/switch —
// the backward-compatible, one-call blocking path (SwitchTo's own doc
// comment). The new low-downtime flow is Prepare then Activate below.
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

// Prepare handles POST /api/v1/database-management/databases/:name/prepare.
// Kicks Manager.Prepare off in the background and returns immediately —
// callers poll List for the resulting status ("preparing" -> "ready" or
// "failed"). Uses context.Background() rather than the request's own
// context: the request ends the instant this handler returns, but the
// provisioning work it just started must keep running regardless.
func (h *Handler) Prepare(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	name := c.Param("name")
	if err := validateName(name); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	}
	go func() { _ = h.mgr.Prepare(context.Background(), name) }()
	return c.JSON(http.StatusAccepted, map[string]any{"name": name, "status": StatusPreparing})
}

// Activate handles POST /api/v1/database-management/databases/:name/activate
// — the fast path, synchronous because it's now genuinely quick (Activate's
// own doc comment). 409s when name has no ready standby behind it yet.
func (h *Handler) Activate(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	name := c.Param("name")
	if err := h.mgr.Activate(c.Request().Context(), name); err != nil {
		if errors.Is(err, ErrNotReady) {
			return errorJSON(c, http.StatusConflict, "NOT_READY", err.Error())
		}
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"name": name, "active": true})
}

// DiscardPrepared handles DELETE .../databases/:name/prepare — releases a
// prepared standby without activating it.
func (h *Handler) DiscardPrepared(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	h.mgr.Discard(c.Param("name"))
	return c.NoContent(http.StatusNoContent)
}

// Delete handles DELETE /api/v1/database-management/databases/:name.
func (h *Handler) Delete(c echo.Context) error {
	if !RequireMasterKey(c, h.mgr.masterKey) {
		return nil
	}
	name := c.Param("name")
	if err := h.mgr.Delete(c.Request().Context(), name); err != nil {
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
