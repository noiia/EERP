package website

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"core/internal/module"

	"github.com/labstack/echo/v5"
)

// BlockTypes is the closed set of block types — keep in sync with
// core-front/apps/shell/src/website/types.ts BLOCK_TYPES.
var BlockTypes = map[string]bool{
	"text": true, "image": true, "hero": true, "record_list": true, "record_detail": true, "record_carousel": true, "image_carousel": true,
	"event_booking": true, "appointment_booking": true, "event_list": true, "section": true,
}

// ReservedSlugs are first path segments the site can never own.
var ReservedSlugs = map[string]bool{
	"app": true, "api": true, "print": true, "database": true, "login": true, "signup": true,
	"account": true, "settings": true, "appstore": true, "force-password-change": true, "booking": true, "_next": true, "favicon.ico": true,
}

// gridCols: 36 columns (3x finer than the original 12; Migrate scaled old layouts).
const gridCols = 36

var (
	slugPattern    = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	blockIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	errPage        = errors.New("invalid page")
)

type block struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// validatePage checks the keys present in body (a PUT may send a subset).
// isModule reports registered Go module names, refused as slugs: proxy.ts
// 308s those first segments into /app, so a page owning one is unreachable.
func validatePage(body map[string]any, isModule func(string) bool) error {
	if raw, ok := body["slug"]; ok {
		slug, isStr := raw.(string)
		if !isStr {
			return fmt.Errorf("%w: slug must be a string", errPage)
		}
		if ReservedSlugs[slug] || isModule(slug) {
			return fmt.Errorf("%w: slug %q is reserved", errPage, slug)
		}
		if slug != "" && !slugPattern.MatchString(slug) {
			return fmt.Errorf("%w: slug must be lowercase letters, digits and dashes", errPage)
		}
	}
	raw, ok := body["layout"]
	if !ok || raw == nil {
		return nil
	}
	enc, _ := json.Marshal(raw)
	var blocks []block
	if err := json.Unmarshal(enc, &blocks); err != nil {
		return fmt.Errorf("%w: layout must be an array of blocks", errPage)
	}
	seen := map[string]bool{}
	for _, b := range blocks {
		switch {
		case !blockIDPattern.MatchString(b.ID):
			return fmt.Errorf("%w: block id %q must be 1-64 letters, digits, - or _", errPage, b.ID)
		case seen[b.ID]:
			return fmt.Errorf("%w: duplicate block id %q", errPage, b.ID)
		case !BlockTypes[b.Type]:
			return fmt.Errorf("%w: block %q: unknown type %q", errPage, b.ID, b.Type)
		case b.X < 0 || b.Y < 0:
			return fmt.Errorf("%w: block %q: x/y must be >= 0", errPage, b.ID)
		case b.W < 1 || b.H < 1:
			return fmt.Errorf("%w: block %q: w/h must be >= 1", errPage, b.ID)
		case b.X+b.W > gridCols:
			return fmt.Errorf("%w: block %q exceeds the grid's %d columns", errPage, b.ID, gridCols)
		}
		seen[b.ID] = true
	}
	return nil
}

// ValidatePageBody runs in front of the GENERIC website_page Create/Update
// handlers: it validates, then restores the body for the generic handler to bind.
func ValidatePageBody(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		raw, err := io.ReadAll(c.Request().Body)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "unreadable body")
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
		}
		if err := validatePage(body, module.IsGoModule); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		c.Request().Body = io.NopCloser(bytes.NewReader(raw))
		return next(c)
	}
}
