package settings

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"

	"core/internal/auth"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// UserViewLayout is one user's saved layout of a diagram view mode (WBS / PERT)
// of an entity: where they dragged the boxes and which branches they folded.
// Per user, unlike the tenant-wide app_settings; off the generic CRUD surface,
// the handler below is its only HTTP path. Unique (tenant_id, user_id, entity,
// mode) is hand-written in the settings module's Migrate.
type UserViewLayout struct {
	model.BaseModel
	UserID uuid.UUID `db:"user_id,index"`
	Entity string    `db:"entity"`
	Mode   string    `db:"mode"`
	Layout string    `db:"layout"` // JSON of viewLayout
}

const (
	maxLayoutPositions = 2000
	maxLayoutIDLen     = 300
	maxLayoutCoord     = 1e6
)

var (
	layoutEntityPattern = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
	layoutModes         = map[string]bool{"wbs": true, "pert": true}
	layoutKey           = []string{"tenant_id", "user_id", "entity", "mode"}
)

type layoutPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type viewLayout struct {
	Positions map[string]layoutPoint `json:"positions"`
	Folded    []string               `json:"folded"`
}

func (l *viewLayout) validate() error {
	if len(l.Positions) > maxLayoutPositions || len(l.Folded) > maxLayoutPositions {
		return fmt.Errorf("at most %d positions and %d folded ids", maxLayoutPositions, maxLayoutPositions)
	}
	check := func(id string) error {
		if id == "" || len(id) > maxLayoutIDLen {
			return fmt.Errorf("ids must be 1–%d characters", maxLayoutIDLen)
		}
		return nil
	}
	for id, p := range l.Positions {
		if err := check(id); err != nil {
			return err
		}
		for _, v := range []float64{p.X, p.Y} {
			if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > maxLayoutCoord {
				return fmt.Errorf("position of %q is out of range", id)
			}
		}
	}
	for _, id := range l.Folded {
		if err := check(id); err != nil {
			return err
		}
	}
	return nil
}

// ViewLayoutHandler serves GET|PUT /api/v1/me/view_layout/:entity/:mode, the
// caller's own layout only (tenant and user come from the JWT).
type ViewLayoutHandler struct {
	rows *orm.Repository[UserViewLayout]
}

func NewViewLayoutHandler(db *orm.DB) *ViewLayoutHandler {
	return &ViewLayoutHandler{rows: orm.MustRepo[UserViewLayout](db)}
}

func layoutParams(c *echo.Context) (entity, mode string, ok bool) {
	entity, mode = c.Param("entity"), c.Param("mode")
	return entity, mode, layoutEntityPattern.MatchString(entity) && layoutModes[mode]
}

func badLayoutParams(c *echo.Context) error {
	return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Unknown entity or mode.")
}

// Get: nothing saved (or an unreadable value) reads as an empty layout.
func (h *ViewLayoutHandler) Get(c *echo.Context) error {
	entity, mode, ok := layoutParams(c)
	if !ok {
		return badLayoutParams(c)
	}
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	found, err := h.rows.FindAll(ctx,
		orm.Cond("tenant_id = $1", id.TenantID), orm.Cond("user_id = $1", id.UserID),
		orm.Cond("entity = $1", entity), orm.Cond("mode = $1", mode))
	if err != nil {
		return fmt.Errorf("view layout: read: %w", err)
	}
	l := viewLayout{}
	if len(found) > 0 {
		_ = json.Unmarshal([]byte(found[0].Layout), &l)
	}
	if l.Positions == nil {
		l.Positions = map[string]layoutPoint{}
	}
	if l.Folded == nil {
		l.Folded = []string{}
	}
	return c.JSON(http.StatusOK, l)
}

// Put replaces the whole layout.
func (h *ViewLayoutHandler) Put(c *echo.Context) error {
	entity, mode, ok := layoutParams(c)
	if !ok {
		return badLayoutParams(c)
	}
	var l viewLayout
	if err := c.Bind(&l); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	if err := l.validate(); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
	}
	if l.Positions == nil {
		l.Positions = map[string]layoutPoint{}
	}
	if l.Folded == nil {
		l.Folded = []string{}
	}
	raw, _ := json.Marshal(l)
	ctx := c.Request().Context()
	id := auth.MustIdentity(ctx)
	if _, err := h.rows.Upsert(ctx,
		UserViewLayout{BaseModel: model.BaseModel{TenantID: id.TenantID}, UserID: id.UserID, Entity: entity, Mode: mode, Layout: string(raw)},
		layoutKey, "layout = EXCLUDED.layout, updated_at = now()"); err != nil {
		return fmt.Errorf("view layout: save: %w", err)
	}
	return c.NoContent(http.StatusNoContent)
}
