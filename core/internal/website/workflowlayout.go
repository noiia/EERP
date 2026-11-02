package website

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"

	"core/internal/auth"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// WorkflowLayoutKey stores where staff placed the boxes of the Website app's
// workflow map (core-front app/app/website/workflows). It is shared by every
// staff user of the tenant, so the map reads the same for the whole team. The
// map itself is derived from the pages' layouts; this only holds positions,
// keyed by the map's node ids (`page:<slug>`, `sys:login`, `ext:<host>`…). A
// node without a position is placed by the map's automatic layout, and a
// position whose node no longer exists is simply never used.
const WorkflowLayoutKey = "website.workflow_layout"

const (
	maxWorkflowNodes  = 2000
	maxWorkflowNodeID = 300
	maxWorkflowCoord  = 1e6
)

// Point is one node's top-left corner on the map, in map pixels.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// WorkflowLayout is the stored value: node id → position.
type WorkflowLayout struct {
	Positions map[string]Point `json:"positions"`
}

func (l *WorkflowLayout) validate() error {
	if len(l.Positions) > maxWorkflowNodes {
		return fmt.Errorf("at most %d positions", maxWorkflowNodes)
	}
	for id, p := range l.Positions {
		if id == "" || len(id) > maxWorkflowNodeID {
			return fmt.Errorf("node ids must be 1–%d characters", maxWorkflowNodeID)
		}
		for _, v := range []float64{p.X, p.Y} {
			if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > maxWorkflowCoord {
				return fmt.Errorf("position of %q is out of range", id)
			}
		}
	}
	return nil
}

type WorkflowLayoutHandler struct{ store SettingsStore }

func NewWorkflowLayoutHandler(store SettingsStore) *WorkflowLayoutHandler {
	return &WorkflowLayoutHandler{store: store}
}

// Get handles GET /api/v1/settings/website/workflow_layout. Nothing saved
// (or an unreadable value) reads as no positions, never a 404.
func (h *WorkflowLayoutHandler) Get(c *echo.Context) error {
	ctx := c.Request().Context()
	raw, found, err := h.store.Get(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, WorkflowLayoutKey)
	if err != nil {
		return err
	}
	l := WorkflowLayout{}
	if found && raw != "" {
		_ = json.Unmarshal([]byte(raw), &l)
	}
	if l.Positions == nil {
		l.Positions = map[string]Point{}
	}
	return c.JSON(http.StatusOK, l)
}

// Put handles PUT /api/v1/settings/website/workflow_layout: replaces every
// position (the map sends the whole set).
func (h *WorkflowLayoutHandler) Put(c *echo.Context) error {
	var l WorkflowLayout
	if err := c.Bind(&l); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "malformed body")
	}
	if l.Positions == nil {
		l.Positions = map[string]Point{}
	}
	if err := l.validate(); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}
	raw, _ := json.Marshal(l)
	ctx := c.Request().Context()
	if err := h.store.Set(ctx, auth.MustIdentity(ctx).TenantID, uuid.Nil, WorkflowLayoutKey, string(raw)); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
