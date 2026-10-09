package website

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Site-wide settings behind the legal notice page, /.well-known/security.txt
// and /robots.txt. Stored like website.routing: one JSON value per key in
// app_settings' site-wide slot (company_id = uuid.Nil).
const (
	LegalKey    = "website.legal"
	SecurityKey = "website.security"
	RobotsKey   = "website.robots"
)

// Legal is the site's legal notice ("mentions légales", French LCEN art. 6):
// who publishes the site and who hosts it, plus free text (credits, privacy…).
type Legal struct {
	CompanyName         string `json:"company_name"`
	LegalForm           string `json:"legal_form"`
	ShareCapital        string `json:"share_capital"`
	Address             string `json:"address"`
	Registration        string `json:"registration"`
	VATNumber           string `json:"vat_number"`
	PublicationDirector string `json:"publication_director"`
	ContactEmail        string `json:"contact_email"`
	ContactPhone        string `json:"contact_phone"`
	HostName            string `json:"host_name"`
	HostAddress         string `json:"host_address"`
	HostPhone           string `json:"host_phone"`
	ExtraText           string `json:"extra_text"`
}

// Security is the RFC 9116 security.txt content.
type Security struct {
	Contacts           []string `json:"contacts"`
	Expires            string   `json:"expires"`
	Policy             string   `json:"policy"`
	Acknowledgments    string   `json:"acknowledgments"`
	Encryption         string   `json:"encryption"`
	PreferredLanguages string   `json:"preferred_languages"`
}

// Robots holds the admin's extra robots.txt lines, appended to the generated rules.
type Robots struct {
	Extra string `json:"extra"`
}

var (
	errSiteFile  = errors.New("invalid settings")
	langsPattern = regexp.MustCompile(`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*(, ?[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)*$`)
)

const (
	maxField     = 500
	maxLongField = 20000
)

func (l *Legal) normalize() error {
	short := []*string{&l.CompanyName, &l.LegalForm, &l.ShareCapital, &l.Registration, &l.VATNumber,
		&l.PublicationDirector, &l.ContactEmail, &l.ContactPhone, &l.HostName, &l.HostPhone, &l.Address, &l.HostAddress}
	for _, f := range short {
		*f = strings.TrimSpace(*f)
		if utf8.RuneCountInString(*f) > maxField {
			return fmt.Errorf("%w: fields are limited to %d characters", errSiteFile, maxField)
		}
	}
	l.ExtraText = strings.TrimSpace(strings.ReplaceAll(l.ExtraText, "\r\n", "\n"))
	if utf8.RuneCountInString(l.ExtraText) > maxLongField {
		return fmt.Errorf("%w: the free text is limited to %d characters", errSiteFile, maxLongField)
	}
	if l.ContactEmail != "" {
		if a, err := mail.ParseAddress(l.ContactEmail); err != nil || a.Address != l.ContactEmail {
			return fmt.Errorf("%w: contact_email is not a valid email address", errSiteFile)
		}
	}
	return nil
}

func (l Legal) empty() bool { return l == Legal{} }

func httpsURL(s string) bool {
	return strings.HasPrefix(s, "https://") && len(s) > len("https://") && !strings.ContainsAny(s, " \r\n")
}

// normalize validates against RFC 9116; now bounds Expires (in the future,
// at most a year ahead, as the RFC recommends). No contact = disabled, valid.
func (s *Security) normalize(now time.Time) error {
	contacts := s.Contacts[:0]
	for _, c := range s.Contacts {
		if c = strings.TrimSpace(c); c != "" {
			contacts = append(contacts, c)
		}
	}
	s.Contacts = contacts
	s.Expires, s.Policy = strings.TrimSpace(s.Expires), strings.TrimSpace(s.Policy)
	s.Acknowledgments, s.Encryption = strings.TrimSpace(s.Acknowledgments), strings.TrimSpace(s.Encryption)
	s.PreferredLanguages = strings.TrimSpace(s.PreferredLanguages)
	if len(s.Contacts) == 0 {
		return nil
	}
	for _, c := range s.Contacts {
		ok := httpsURL(c)
		if rest, found := strings.CutPrefix(c, "mailto:"); found {
			_, err := mail.ParseAddress(rest)
			ok = err == nil
		} else if rest, found := strings.CutPrefix(c, "tel:"); found {
			ok = rest != "" && !strings.ContainsAny(rest, " \r\n")
		}
		if !ok {
			return fmt.Errorf("%w: contact %q must be a mailto:, tel: or https:// URI", errSiteFile, c)
		}
	}
	exp, err := time.Parse(time.RFC3339, s.Expires)
	if err != nil {
		return fmt.Errorf("%w: expires must be an RFC 3339 date-time", errSiteFile)
	}
	if !exp.After(now) || exp.After(now.AddDate(1, 0, 1)) {
		return fmt.Errorf("%w: expires must be in the future and at most a year away", errSiteFile)
	}
	s.Expires = exp.UTC().Format(time.RFC3339)
	for _, u := range []string{s.Policy, s.Acknowledgments, s.Encryption} {
		if u != "" && !httpsURL(u) {
			return fmt.Errorf("%w: policy, acknowledgments and encryption must be https:// URLs", errSiteFile)
		}
	}
	if s.PreferredLanguages != "" && !langsPattern.MatchString(s.PreferredLanguages) {
		return fmt.Errorf("%w: preferred_languages is a comma-separated list of language tags (en, fr)", errSiteFile)
	}
	return nil
}

// Text renders security.txt, or "" when there's nothing valid to publish
// (no contact, or the file has expired — an expired file must not be served).
func (s Security) Text(now time.Time) string {
	exp, err := time.Parse(time.RFC3339, s.Expires)
	if len(s.Contacts) == 0 || err != nil || !exp.After(now) {
		return ""
	}
	var b strings.Builder
	for _, c := range s.Contacts {
		b.WriteString("Contact: " + c + "\n")
	}
	b.WriteString("Expires: " + s.Expires + "\n")
	for _, f := range []struct{ name, v string }{
		{"Encryption", s.Encryption}, {"Acknowledgments", s.Acknowledgments},
		{"Policy", s.Policy}, {"Preferred-Languages", s.PreferredLanguages},
	} {
		if f.v != "" {
			b.WriteString(f.name + ": " + f.v + "\n")
		}
	}
	return b.String()
}

// robotsDisallow are the non-content paths of the site host: the ERP, the API,
// report print targets, the database manager and the visitor's own pages.
var robotsDisallow = []string{"/app/", "/api/", "/print/", "/database/", "/login", "/signup", "/account", "/booking/"}

// RobotsText renders robots.txt for a request on host. The ERP host (host
// routing mode) is closed to crawlers entirely; everything else gets the site
// rules plus the admin's extra lines.
func RobotsText(r Routing, extra Robots, host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if r.Mode == "host" && r.ERPHost != "" && strings.EqualFold(host, r.ERPHost) {
		return "User-agent: *\nDisallow: /\n"
	}
	var b strings.Builder
	b.WriteString("User-agent: *\n")
	for _, p := range robotsDisallow {
		b.WriteString("Disallow: " + p + "\n")
	}
	if extra.Extra != "" {
		b.WriteString("\n" + extra.Extra + "\n")
	}
	return b.String()
}

// SiteFilesHandler serves the legal notice, security.txt and robots.txt
// settings (ERP, settings:website:*) and their public renderings (site tenant).
type SiteFilesHandler struct {
	store      SettingsStore
	siteTenant uuid.UUID
	routing    *RoutingHandler
	now        func() time.Time
}

func NewSiteFilesHandler(store SettingsStore, siteTenant uuid.UUID) *SiteFilesHandler {
	return &SiteFilesHandler{store: store, siteTenant: siteTenant, routing: NewRoutingHandler(store, siteTenant), now: time.Now}
}

// loadJSON reads key into out; absent or unparsable leaves out at its zero value.
func (h *SiteFilesHandler) loadJSON(ctx context.Context, tenant uuid.UUID, key string, out any) error {
	raw, found, err := h.store.Get(ctx, tenant, uuid.Nil, key)
	if err != nil {
		return err
	}
	if found && raw != "" {
		_ = json.Unmarshal([]byte(raw), out)
	}
	return nil
}

func (h *SiteFilesHandler) saveJSON(c *echo.Context, key string, v any) error {
	raw, _ := json.Marshal(v)
	ctx := c.Request().Context()
	if err := h.store.Set(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, key, string(raw)); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *SiteFilesHandler) getOwn(c *echo.Context, key string, out any) error {
	ctx := c.Request().Context()
	if err := h.loadJSON(ctx, auth.MustIdentity(ctx).TenantID, key, out); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}

// GetLegal handles GET /api/v1/settings/website/legal.
func (h *SiteFilesHandler) GetLegal(c *echo.Context) error { return h.getOwn(c, LegalKey, &Legal{}) }

// PutLegal handles PUT /api/v1/settings/website/legal.
func (h *SiteFilesHandler) PutLegal(c *echo.Context) error {
	var l Legal
	if err := c.Bind(&l); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := l.normalize(); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	return h.saveJSON(c, LegalKey, l)
}

// GetSecurity handles GET /api/v1/settings/website/security.
func (h *SiteFilesHandler) GetSecurity(c *echo.Context) error {
	s := Security{Contacts: []string{}}
	return h.getOwn(c, SecurityKey, &s)
}

// PutSecurity handles PUT /api/v1/settings/website/security.
func (h *SiteFilesHandler) PutSecurity(c *echo.Context) error {
	var s Security
	if err := c.Bind(&s); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if err := s.normalize(h.now()); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	return h.saveJSON(c, SecurityKey, s)
}

// GetRobots handles GET /api/v1/settings/website/robots.
func (h *SiteFilesHandler) GetRobots(c *echo.Context) error { return h.getOwn(c, RobotsKey, &Robots{}) }

// PutRobots handles PUT /api/v1/settings/website/robots.
func (h *SiteFilesHandler) PutRobots(c *echo.Context) error {
	var r Robots
	if err := c.Bind(&r); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	r.Extra = strings.TrimSpace(strings.ReplaceAll(r.Extra, "\r\n", "\n"))
	if utf8.RuneCountInString(r.Extra) > maxLongField {
		return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("extra lines are limited to %d characters", maxLongField))
	}
	return h.saveJSON(c, RobotsKey, r)
}

// PublicLegal handles GET /api/v1/public/legal — 404 until something is set.
func (h *SiteFilesHandler) PublicLegal(c *echo.Context) error {
	var l Legal
	if err := h.loadJSON(c.Request().Context(), h.siteTenant, LegalKey, &l); err != nil {
		return err
	}
	if l.empty() {
		return echo.NewHTTPError(http.StatusNotFound, "no legal notice")
	}
	return c.JSON(http.StatusOK, l)
}

// PublicSecurityTxt handles GET /api/v1/public/security.txt — 404 when no
// contact is set or the file has expired.
func (h *SiteFilesHandler) PublicSecurityTxt(c *echo.Context) error {
	var s Security
	if err := h.loadJSON(c.Request().Context(), h.siteTenant, SecurityKey, &s); err != nil {
		return err
	}
	text := s.Text(h.now())
	if text == "" {
		return echo.NewHTTPError(http.StatusNotFound, "no security.txt")
	}
	return c.Blob(http.StatusOK, "text/plain; charset=utf-8", []byte(text))
}

// PublicRobotsTxt handles GET /api/v1/public/robots.txt?host=<request host>:
// the frontend passes the host the crawler asked, since only it knows.
func (h *SiteFilesHandler) PublicRobotsTxt(c *echo.Context) error {
	ctx := c.Request().Context()
	r, err := h.routing.load(ctx, h.siteTenant)
	if err != nil {
		return err
	}
	var extra Robots
	if err := h.loadJSON(ctx, h.siteTenant, RobotsKey, &extra); err != nil {
		return err
	}
	return c.Blob(http.StatusOK, "text/plain; charset=utf-8", []byte(RobotsText(r, extra, c.QueryParam("host"))))
}
