package propertymanagement

import (
	"context"
	"encoding/json"
	"net/http"

	"core/internal/auth"
	"core/internal/settings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// SettingsKey holds the Property management app's workspace settings as JSON,
// in app_settings' tenant-wide slot (company_id = uuid.Nil). Edited in
// Settings -> Apps -> Property management.
const SettingsKey = "propertymanagement.settings"

// Settings are the Property management app's workspace settings. The zero
// value is the default — a tenant that never saved any reads as all false.
type Settings struct {
	// DisplayTaxesOnReport prints the Tax column on rent receipt PDFs.
	DisplayTaxesOnReport bool `json:"display_taxes_on_report"`
}

// LoadSettings reads the tenant's settings; absent reads as the zero value.
func LoadSettings(ctx context.Context, store *settings.Repository, tenant uuid.UUID) (Settings, error) {
	var s Settings
	raw, ok, err := store.Get(ctx, tenant, uuid.Nil, SettingsKey)
	if err != nil || !ok || raw == "" {
		return s, err
	}
	err = json.Unmarshal([]byte(raw), &s)
	return s, err
}

// GetSettings handles GET /api/v1/settings/propertymanagement
// (settings:propertymanagement:read, route-derived).
func (h *Handler) GetSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	identity, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	s, err := LoadSettings(ctx, h.settingsStore, identity.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, s)
}

// PutSettings handles PUT /api/v1/settings/propertymanagement
// (settings:propertymanagement:write, route-derived).
func (h *Handler) PutSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	identity, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	var in Settings
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	raw, _ := json.Marshal(in)
	if err := h.settingsStore.Set(ctx, identity.TenantID, uuid.Nil, SettingsKey, string(raw)); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, in)
}

// GetRentReceipt handles GET /api/v1/property_management_rent_receipt/:id:
// the generic read plus a computed, non-stored display_taxes key — the
// workspace's DisplayTaxesOnReport as it is NOW, which the rent receipt
// report's Tax column reads (rent_receipt_report.ts). The PDF is rendered at
// (re)generation, so it follows the setting at that moment.
func (h *Handler) GetRentReceipt(c *echo.Context) error {
	ctx := c.Request().Context()
	identity, ok := auth.IdentityFromContext(ctx)
	if !ok {
		return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
	}
	id, err := echo.PathParam[uuid.UUID](c, "id")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}
	receipt, err := findOwned(ctx, h.rentReceipts, id, identity.TenantID)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Rent receipt not found.")
	}
	s, err := LoadSettings(ctx, h.settingsStore, identity.TenantID)
	if err != nil {
		return err
	}
	out := toColumnMap(h.rentReceipts, receipt)
	out["display_taxes"] = s.DisplayTaxesOnReport
	return c.JSON(http.StatusOK, out)
}
