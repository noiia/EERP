package graphfield

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"core/internal/auth"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// Mounted behind jwtMw + permMw (graph_fields:graph_fields:read|write|delete
// derived from the route); every query is tenant-pinned.

var (
	entityPattern  = regexp.MustCompile(`^[a-z0-9_]{1,63}$`)
	keyPattern     = regexp.MustCompile(`^calc_[a-z0-9_]{1,56}$`)
	formulaPattern = regexp.MustCompile(`^[A-Za-z0-9_+\-*/(). ]{1,500}$`)
)

type store interface {
	Create(ctx context.Context, f GraphField) (GraphField, error)
	Update(ctx context.Context, f GraphField, id uuid.UUID) (GraphField, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (GraphField, error)
	List(ctx context.Context, tenantID uuid.UUID, entity string) ([]GraphField, error)
	Delete(ctx context.Context, id uuid.UUID) error
}

type Handler struct{ store store }

func NewHandler(s *Repository) *Handler { return &Handler{store: s} }

type fieldResponse struct {
	ID      uuid.UUID `json:"id"`
	Entity  string    `json:"entity"`
	Key     string    `json:"key"`
	Label   string    `json:"label"`
	Formula string    `json:"formula"`
	Roles   []string  `json:"roles"`
	Dated   bool      `json:"dated"`
}

func splitRoles(s string) []string {
	out := []string{}
	for _, r := range strings.Split(s, ",") {
		if r = strings.TrimSpace(r); r != "" {
			out = append(out, r)
		}
	}
	return out
}

func toResponse(f GraphField) fieldResponse {
	return fieldResponse{ID: f.ID, Entity: f.Entity, Key: f.Key, Label: f.Label, Formula: f.Formula, Roles: splitRoles(f.Roles), Dated: f.Dated}
}

// visible: empty Roles = everyone; otherwise the caller needs one of them,
// by role technical name or inherited group (identity.Groups).
func visible(f GraphField, id auth.Identity) bool {
	roles := splitRoles(f.Roles)
	if len(roles) == 0 {
		return true
	}
	have := map[string]bool{}
	for _, r := range id.Roles {
		have[r] = true
	}
	for _, g := range id.Groups {
		have[g] = true
	}
	for _, r := range roles {
		if have[r] {
			return true
		}
	}
	return false
}

// List handles GET /api/v1/graph_fields?entity= — {data,total}, role-filtered.
func (h *Handler) List(c echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	entity := c.QueryParam("entity")
	if !entityPattern.MatchString(entity) {
		return errorJSON(c, http.StatusBadRequest, "entity must be a lowercase identifier.")
	}
	rows, err := h.store.List(c.Request().Context(), id.TenantID, entity)
	if err != nil {
		return fmt.Errorf("graph_field: list: %w", err)
	}
	data := []fieldResponse{}
	for _, f := range rows {
		if visible(f, id) {
			data = append(data, toResponse(f))
		}
	}
	return c.JSON(http.StatusOK, map[string]any{"data": data, "total": len(data)})
}

// Create handles POST /api/v1/graph_fields.
func (h *Handler) Create(c echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	var req struct {
		Entity, Key, Label, Formula string
		Roles                       []string
		Dated                       bool
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "Malformed request body.")
	}
	switch {
	case !entityPattern.MatchString(req.Entity):
		return errorJSON(c, http.StatusBadRequest, "entity must be a lowercase identifier.")
	case !keyPattern.MatchString(req.Key):
		return errorJSON(c, http.StatusBadRequest, "key must look like calc_<lowercase letters, digits, _>.")
	}
	if msg := validateBody(req.Label, req.Formula, req.Roles); msg != "" {
		return errorJSON(c, http.StatusBadRequest, msg)
	}
	created, err := h.store.Create(c.Request().Context(), GraphField{
		BaseModel: model.BaseModel{TenantID: id.TenantID},
		Entity:    req.Entity, Key: req.Key, Label: req.Label, Formula: req.Formula,
		Roles: strings.Join(req.Roles, ","), Dated: req.Dated,
	})
	if errors.Is(err, ErrDuplicateKey) {
		return errorJSON(c, http.StatusConflict, ErrDuplicateKey.Error())
	}
	if err != nil {
		return fmt.Errorf("graph_field: create: %w", err)
	}
	return c.JSON(http.StatusCreated, toResponse(created))
}

// Update handles PUT /api/v1/graph_fields/:id — label, formula, roles, dated
// (the key is immutable). A field the caller's roles can't see behaves like a missing one.
func (h *Handler) Update(c echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	fid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "id must be a UUID.")
	}
	var req struct {
		Label, Formula string
		Roles          []string
		Dated          bool
	}
	if err := c.Bind(&req); err != nil {
		return errorJSON(c, http.StatusBadRequest, "Malformed request body.")
	}
	if msg := validateBody(req.Label, req.Formula, req.Roles); msg != "" {
		return errorJSON(c, http.StatusBadRequest, msg)
	}
	f, err := h.store.FindInTenant(c.Request().Context(), id.TenantID, fid)
	if err == nil && !visible(f, id) {
		err = orm.ErrNotFound
	}
	if errors.Is(err, orm.ErrNotFound) {
		return errorJSON(c, http.StatusNotFound, "No such graph field.")
	}
	if err != nil {
		return fmt.Errorf("graph_field: update: find: %w", err)
	}
	f.Label, f.Formula, f.Roles, f.Dated = req.Label, req.Formula, strings.Join(req.Roles, ","), req.Dated
	updated, err := h.store.Update(c.Request().Context(), f, fid)
	if err != nil {
		return fmt.Errorf("graph_field: update: %w", err)
	}
	return c.JSON(http.StatusOK, toResponse(updated))
}

// validateBody checks the fields Create and Update share; "" = valid.
func validateBody(label, formula string, roles []string) string {
	switch {
	case label == "" || len(label) > 200:
		return "label is required (max 200 characters)."
	case !formulaPattern.MatchString(formula):
		return "formula may only use field names, numbers, + - * / and parentheses."
	}
	for _, r := range roles {
		if strings.ContainsAny(r, ", ") {
			return "role names must not contain commas or spaces."
		}
	}
	return ""
}

// Delete handles DELETE /api/v1/graph_fields/:id. A field the caller's roles
// can't see behaves like a missing one.
func (h *Handler) Delete(c echo.Context) error {
	id := auth.MustIdentity(c.Request().Context())
	fid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "id must be a UUID.")
	}
	f, err := h.store.FindInTenant(c.Request().Context(), id.TenantID, fid)
	if err == nil && !visible(f, id) {
		err = orm.ErrNotFound
	}
	if errors.Is(err, orm.ErrNotFound) {
		return errorJSON(c, http.StatusNotFound, "No such graph field.")
	}
	if err != nil {
		return fmt.Errorf("graph_field: delete: find: %w", err)
	}
	if err := h.store.Delete(c.Request().Context(), fid); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func errorJSON(c echo.Context, status int, msg string) error {
	return c.JSON(status, map[string]any{"error": map[string]any{
		"code": http.StatusText(status), "message": msg, "request_id": c.Response().Header().Get(echo.HeaderXRequestID),
	}})
}
