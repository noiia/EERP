package website

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"

	"core/internal/auth"
	"core/internal/settings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// LocalizationKey stores the site's language and currency defaults, edited in
// Settings → Website → Language & currency. Visitors override both from the
// site footer (an account keeps its choice, an anonymous visitor a cookie).
const LocalizationKey = "website.localization"

var currencyCode = regexp.MustCompile(`^[A-Z]{3}$`)

// The same tag shape internal/settings accepts for interface languages.
var siteLocaleTag = regexp.MustCompile(`^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,3}$`)

const maxOfferedCurrencies = 40

// Localization is the stored value. Prices are stored in the workspace
// currency (the base); every other currency is a display conversion only —
// bookings and invoices stay in the base.
type Localization struct {
	// DefaultLocale: the language a first-time visitor sees ("" = the source
	// language).
	DefaultLocale string `json:"default_locale"`
	// DefaultCurrency: shown to a first-time visitor ("" = the base).
	DefaultCurrency string `json:"default_currency"`
	// Currencies: the extra currencies the footer offers besides the base.
	Currencies []string `json:"currencies"`
	// Overrides: hand-set rates (1 base = rate units) replacing the live rate.
	Overrides map[string]float64 `json:"overrides"`
}

func (l *Localization) normalize() {
	if l.Currencies == nil {
		l.Currencies = []string{}
	}
	if l.Overrides == nil {
		l.Overrides = map[string]float64{}
	}
}

func (l *Localization) validate(base string) error {
	if l.DefaultLocale != "" && !siteLocaleTag.MatchString(l.DefaultLocale) {
		return fmt.Errorf("default_locale must be empty or a locale tag like fr or pt-BR")
	}
	if len(l.Currencies) > maxOfferedCurrencies {
		return fmt.Errorf("at most %d currencies", maxOfferedCurrencies)
	}
	seen := map[string]bool{base: true}
	for _, c := range l.Currencies {
		if !currencyCode.MatchString(c) {
			return fmt.Errorf("%q is not an ISO 4217 code (three capital letters)", c)
		}
		if seen[c] {
			return fmt.Errorf("%s is listed twice (or is the workspace currency)", c)
		}
		seen[c] = true
	}
	if l.DefaultCurrency != "" && !seen[l.DefaultCurrency] {
		return fmt.Errorf("default_currency must be the workspace currency or one of the offered currencies")
	}
	for c, r := range l.Overrides {
		if !slices.Contains(l.Currencies, c) {
			return fmt.Errorf("a rate is set for %s, which is not offered", c)
		}
		if math.IsNaN(r) || math.IsInf(r, 0) || r <= 0 || r > 1e9 {
			return fmt.Errorf("the rate of %s must be a positive number", c)
		}
	}
	return nil
}

// SiteCompany resolves the company whose currency prices are expressed in and
// whose format settings the site reads (event prices use the same one).
type SiteCompany func(ctx context.Context, tenant uuid.UUID) (id uuid.UUID, currency string, err error)

type LocalizationHandler struct {
	store      SettingsStore
	siteTenant uuid.UUID
	company    SiteCompany
	rates      *LiveRates
}

func NewLocalizationHandler(store SettingsStore, siteTenant uuid.UUID, company SiteCompany, rates *LiveRates) *LocalizationHandler {
	return &LocalizationHandler{store: store, siteTenant: siteTenant, company: company, rates: rates}
}

func (h *LocalizationHandler) load(ctx context.Context, tenant uuid.UUID) (Localization, error) {
	var l Localization
	raw, found, err := h.store.Get(ctx, tenant, uuid.Nil, LocalizationKey)
	if err != nil {
		return l, err
	}
	if found && raw != "" {
		_ = json.Unmarshal([]byte(raw), &l) // unreadable degrades to the defaults
	}
	l.normalize()
	return l, nil
}

// live returns the live rates against base, and the feed's date.
func (h *LocalizationHandler) live(base string) (map[string]float64, string) {
	eur, date := h.rates.Snapshot()
	return relativeTo(eur, base), date
}

type localizationView struct {
	Localization
	// Base: the workspace currency prices are stored in.
	Base string `json:"base"`
	// Live: the live rate of every offered currency it knows (1 base = rate).
	Live     map[string]float64 `json:"live"`
	LiveDate string             `json:"live_date"`
}

// Get handles GET /api/v1/settings/website/localization (settings:website:read).
func (h *LocalizationHandler) Get(c *echo.Context) error {
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	l, err := h.load(ctx, tenant)
	if err != nil {
		return err
	}
	_, base, err := h.company(ctx, tenant)
	if err != nil {
		return err
	}
	all, date := h.live(base)
	live := map[string]float64{}
	for _, c := range l.Currencies {
		if r, ok := all[c]; ok {
			live[c] = r
		}
	}
	return c.JSON(http.StatusOK, localizationView{Localization: l, Base: base, Live: live, LiveDate: date})
}

// Put handles PUT /api/v1/settings/website/localization (settings:website:write).
func (h *LocalizationHandler) Put(c *echo.Context) error {
	var l Localization
	if err := c.Bind(&l); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	l.normalize()
	ctx := c.Request().Context()
	tenant := auth.MustIdentity(ctx).TenantID
	_, base, err := h.company(ctx, tenant)
	if err != nil {
		return err
	}
	if err := l.validate(base); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	raw, _ := json.Marshal(l)
	if err := h.store.Set(ctx, tenant, uuid.Nil, LocalizationKey, string(raw)); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// PublicLocalization is what the site renders prices and dates with.
type PublicLocalization struct {
	DefaultLocale   string `json:"default_locale"`
	DefaultCurrency string `json:"default_currency"`
	Base            string `json:"base"`
	// Rates: 1 base = rate units, for the base and every offered currency
	// with a rate (an override, else the live one). A currency without any
	// rate is not offered: showing it unconverted would show a wrong price.
	Rates map[string]float64 `json:"rates"`
	// Currencies: the footer's choices in order, the base first.
	Currencies []string `json:"currencies"`
	// DateFormat: the workspace short date format, "" = locale default.
	DateFormat string `json:"date_format"`
}

// Resolve builds the site tenant's PublicLocalization.
func (h *LocalizationHandler) Resolve(ctx context.Context) (PublicLocalization, error) {
	l, err := h.load(ctx, h.siteTenant)
	if err != nil {
		return PublicLocalization{}, err
	}
	companyID, base, err := h.company(ctx, h.siteTenant)
	if err != nil {
		return PublicLocalization{}, err
	}
	out := PublicLocalization{DefaultLocale: l.DefaultLocale, Base: base, Rates: map[string]float64{}, Currencies: []string{}}
	if base != "" {
		out.Rates[base] = 1
		out.Currencies = append(out.Currencies, base)
		live, _ := h.live(base)
		for _, c := range l.Currencies {
			r, ok := l.Overrides[c]
			if !ok {
				r, ok = live[c]
			}
			if ok {
				out.Rates[c] = r
				out.Currencies = append(out.Currencies, c)
			}
		}
	}
	if _, ok := out.Rates[l.DefaultCurrency]; ok {
		out.DefaultCurrency = l.DefaultCurrency
	} else {
		out.DefaultCurrency = base
	}
	if companyID != uuid.Nil {
		f, found, err := h.store.Get(ctx, h.siteTenant, companyID, settings.DateFormatKey)
		if err != nil {
			return PublicLocalization{}, err
		}
		if found && settings.DateFormats[f] {
			out.DateFormat = f
		}
	}
	return out, nil
}

// Public handles GET /api/v1/public/localization (anonymous).
func (h *LocalizationHandler) Public(c *echo.Context) error {
	out, err := h.Resolve(c.Request().Context())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}
