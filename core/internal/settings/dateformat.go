package settings

import (
	"fmt"
	"net/http"

	"core/internal/auth"

	"github.com/labstack/echo/v5"
)

// DateFormatKey is the app_settings key holding the workspace's short date
// format — one of DateFormats, stored as the bare pattern ("dd/MM/yyyy").
// Absent means the frontend's locale-driven default. It sits beside
// NumberFormatKey: display config read by the ERP (preferences) and by the
// public website (GET /public/localization), where compact layouts — a
// phone-width booking list — print dates in it instead of a long text date.
const DateFormatKey = "format.date"

// DateFormats is the closed set of accepted patterns: dd, MM and yyyy in
// three orders and three separators. Closed on purpose: the frontend renders
// them with a token replace, so arbitrary patterns would be arbitrary output.
var DateFormats = map[string]bool{
	"dd/MM/yyyy": true, "MM/dd/yyyy": true, "yyyy/MM/dd": true,
	"dd-MM-yyyy": true, "MM-dd-yyyy": true, "yyyy-MM-dd": true,
	"dd.MM.yyyy": true, "MM.dd.yyyy": true, "yyyy.MM.dd": true,
}

// PutDateFormatSettings handles PUT /api/v1/settings/format/date —
// {"date_format": "dd/MM/yyyy"}, or null to go back to the default. Same
// settings:format:write permission (route-derived) as the number format.
func (h *Handler) PutDateFormatSettings(c *echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())
	var req struct {
		DateFormat *string `json:"date_format"`
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	value := ""
	if req.DateFormat != nil {
		if !DateFormats[*req.DateFormat] {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
				"date_format must be null or a pattern like dd/MM/yyyy, MM-dd-yyyy or yyyy-MM-dd.")
		}
		value = *req.DateFormat
	}
	active, err := h.companies.ResolveActive(c.Request().Context(), identity.TenantID, identity.UserID)
	if err != nil {
		return fmt.Errorf("settings: resolve active company: %w", err)
	}
	if err := h.store.Set(c.Request().Context(), identity.TenantID, active.ID, DateFormatKey, value); err != nil {
		return fmt.Errorf("settings: set date format: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}
