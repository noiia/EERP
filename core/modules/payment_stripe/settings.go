package paymentstripe

import (
	"encoding/json"
	"net/http"
	"strings"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// settingsView is what the settings GET returns: never the keys themselves.
type settingsView struct {
	Enabled          bool `json:"enabled"`
	SecretKeySet     bool `json:"secret_key_set"`
	WebhookSecretSet bool `json:"webhook_secret_set"`
	// Active: the module is on (App Store); keys alone don't connect Stripe.
	Active bool `json:"active"`
}

// GetSettings handles GET /api/v1/settings/integrations/stripe
// (settings:integrations:read, route-derived).
func (p *Provider) GetSettings(isActive func(string) bool) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		s, err := p.load(ctx, auth.MustIdentity(ctx).TenantID)
		if err != nil {
			return err
		}
		return c.JSON(http.StatusOK, settingsView{Enabled: s.Enabled, SecretKeySet: s.SecretKey != "",
			WebhookSecretSet: s.WebhookSecret != "", Active: isActive(Name)})
	}
}

// PutSettings handles PUT /api/v1/settings/integrations/stripe
// (settings:integrations:write): {enabled, secret_key?, webhook_secret?} — an
// empty or absent key keeps the saved one, so the form never needs to show it.
func (p *Provider) PutSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	var in Settings
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	s, err := p.load(ctx, tenant)
	if err != nil {
		return err
	}
	s.Enabled = in.Enabled
	if k := strings.TrimSpace(in.SecretKey); k != "" {
		if !strings.HasPrefix(k, "sk_") && !strings.HasPrefix(k, "rk_") {
			return echo.NewHTTPError(http.StatusBadRequest, "the secret key starts with sk_ (or rk_ for a restricted key)")
		}
		s.SecretKey = k
	}
	if w := strings.TrimSpace(in.WebhookSecret); w != "" {
		if !strings.HasPrefix(w, "whsec_") {
			return echo.NewHTTPError(http.StatusBadRequest, "the webhook signing secret starts with whsec_")
		}
		s.WebhookSecret = w
	}
	raw, _ := json.Marshal(s)
	if err := p.store.Set(ctx, tenant, uuid.Nil, SettingsKey, string(raw)); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
