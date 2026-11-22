package backup

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"core/internal/auth"

	"github.com/labstack/echo/v5"
)

// Handler serves the Settings → Developer → Automated backups API. These
// routes act on every database of the server, not just the caller's tenant:
// their backups:backups:* permissions are held by no seeded role but *:*:*.
type Handler struct{ svc *Service }

// NewHandler builds the handler over svc.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Mount registers the routes on g (/api/v1/backups, behind JWT + permissions).
func Mount(g *echo.Group, h *Handler) {
	g.GET("", h.Get)
	g.PUT("", h.Put)
	g.GET("/databases", h.Databases)
	g.GET("/runs", h.Runs)
	g.POST("/run", h.RunNow)
	g.POST("/cancel", h.Cancel)
	g.POST("/cleanup", h.Cleanup)
}

func errorJSON(c *echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

type failure struct {
	At    time.Time `json:"at"`
	Error string    `json:"error"`
}

// Get answers the overview: settings, status, next/last runs, local bundles.
func (h *Handler) Get(c *echo.Context) error {
	settings, err := LoadSettings(h.svc.Dir())
	if err != nil {
		return err
	}
	runs, err := ReadHistory(h.svc.Dir())
	if err != nil {
		return err
	}
	pub, err := ListPublished(h.svc.Dir())
	if err != nil {
		return err
	}
	var lastSuccess *time.Time
	var lastFailure *failure
	for _, r := range runs {
		if r.Status == "success" && lastSuccess == nil {
			lastSuccess = r.FinishedAt
		}
		if (r.Status == "failed" || r.Status == "cancelled") && lastFailure == nil && r.FinishedAt != nil {
			lastFailure = &failure{At: *r.FinishedAt, Error: r.Error}
		}
	}
	var bytes int64
	for _, p := range pub {
		bytes += p.Bytes
	}
	view := map[string]any{}
	raw, _ := json.Marshal(settings)
	_ = json.Unmarshal(raw, &view)
	delete(view, "notify_tenant_id")
	delete(view, "notify_user_id")
	return c.JSON(http.StatusOK, map[string]any{
		"settings":     view,
		"backup_dir":   h.svc.Dir(),
		"running":      h.svc.Current(),
		"next_run":     h.svc.NextRun(time.Now()),
		"last_success": lastSuccess,
		"last_failure": lastFailure,
		"local_count":  len(pub),
		"local_bytes":  bytes,
	})
}

// Put replaces the settings; scheduled runs then notify the caller's tenant.
func (h *Handler) Put(c *echo.Context) error {
	s := Defaults()
	if err := json.NewDecoder(c.Request().Body).Decode(&s); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	ctx := c.Request().Context()
	known, err := h.svc.bundler.DatabaseNames(ctx)
	if err != nil {
		return err
	}
	if err := s.Validate(known); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	}
	id := auth.MustIdentity(ctx)
	s.UpdatedAt, s.NotifyTenant, s.NotifyUser = time.Now().UTC(), id.TenantID, id.UserID
	if err := SaveSettings(h.svc.Dir(), s); err != nil {
		return err
	}
	return h.Get(c)
}

// Databases lists the databases a backup can cover.
func (h *Handler) Databases(c *echo.Context) error {
	names, err := h.svc.bundler.DatabaseNames(c.Request().Context())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": names})
}

// Runs lists the run history, newest first.
func (h *Handler) Runs(c *echo.Context) error {
	runs, err := ReadHistory(h.svc.Dir())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"data": runs, "total": len(runs)})
}

// RunNow starts a manual run (202), reported to the caller's bell.
func (h *Handler) RunNow(c *echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	run, err := h.svc.Start("manual", nil, id.TenantID, id.UserID)
	switch {
	case errors.Is(err, ErrBusy):
		return errorJSON(c, http.StatusConflict, "BACKUP_RUNNING", err.Error())
	case errors.Is(err, ErrNoDatabases):
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Select at least one database first.")
	case err != nil:
		return err
	}
	return c.JSON(http.StatusAccepted, run)
}

// Cancel stops the run in progress in this process.
func (h *Handler) Cancel(c *echo.Context) error {
	return c.JSON(http.StatusOK, map[string]bool{"cancelled": h.svc.Cancel()})
}

// Cleanup applies the retention now.
func (h *Handler) Cleanup(c *echo.Context) error {
	settings, err := LoadSettings(h.svc.Dir())
	if err != nil {
		return err
	}
	removed, err := Retain(h.svc.Dir(), settings.RetentionDays, time.Now(), h.svc.log)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"removed": removed})
}
