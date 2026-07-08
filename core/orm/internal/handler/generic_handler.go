// Package handler provides a generic Echo handler that drives CRUD operations
// for any registered table — no per-table handler files needed.
package handler

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"core/orm/internal/crud"
	"core/orm/internal/registry"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// svcLayer is the service interface the handler depends on.
// Defined here (call-site) per Go convention.
type svcLayer interface {
	List(ctx context.Context, f crud.ListFilter) ([]map[string]any, int, error)
	GetByID(ctx context.Context, id any) (map[string]any, error)
	Create(ctx context.Context, data map[string]any) (map[string]any, error)
	Update(ctx context.Context, id any, data map[string]any) (map[string]any, error)
	Delete(ctx context.Context, id any) error
	Restore(ctx context.Context, id any) (map[string]any, error)
}

// GenericHandler drives all CRUD operations for one registered table.
// A single instance handles every route for that table.
type GenericHandler struct {
	svc  svcLayer
	meta registry.TableMeta
}

// NewGenericHandler constructs a GenericHandler for the given service and table.
func NewGenericHandler(svc *crud.Service, meta registry.TableMeta) *GenericHandler {
	return &GenericHandler{svc: svc, meta: meta}
}

// Meta exposes the TableMeta so the route generator can inspect SoftDelete and RoutePrefix.
func (h *GenericHandler) Meta() registry.TableMeta { return h.meta }

// ── Route handlers ────────────────────────────────────────────────────────────

// bracketColumn extracts the column of a `prefix[column]` query key, e.g.
// bracketColumn("filter[contact_id]", "filter") -> ("contact_id", true).
func bracketColumn(key, prefix string) (string, bool) {
	if !strings.HasPrefix(key, prefix+"[") || !strings.HasSuffix(key, "]") {
		return "", false
	}
	return key[len(prefix)+1 : len(key)-1], true
}

// listFilter builds the ListFilter from the query string:
//
//	?page=&page_size=              pagination (defaults 1 / 20)
//	?filter[<column>]=<value>      exact match — relation scoping (o2m, junctions)
//	?search[<column>]=<text>       case-insensitive containment — autocomplete
//
// Filter columns are validated against the table meta here (friendly 400) and
// again in the repository (the actual security boundary).
func (h *GenericHandler) listFilter(c echo.Context) (crud.ListFilter, error) {
	page, _ := strconv.Atoi(c.QueryParam("page"))
	pageSize, _ := strconv.Atoi(c.QueryParam("page_size"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	f := crud.ListFilter{Page: page, PageSize: pageSize}

	for key, vals := range c.QueryParams() {
		if len(vals) == 0 || vals[0] == "" {
			continue
		}
		into := &f.Equals
		col, ok := bracketColumn(key, "filter")
		if !ok {
			into = &f.Matches
			col, ok = bracketColumn(key, "search")
		}
		if !ok {
			continue
		}
		if !h.meta.HasField(col) {
			return f, echo.NewHTTPError(http.StatusBadRequest, "unknown filter column: "+col)
		}
		if *into == nil {
			*into = make(map[string]string)
		}
		(*into)[col] = vals[0]
	}
	return f, nil
}

// List handles GET /api/v1/{table}?page=&page_size=&filter[col]=&search[col]=
func (h *GenericHandler) List(c echo.Context) error {
	f, err := h.listFilter(c)
	if err != nil {
		return err
	}

	rows, total, err := h.svc.List(c.Request().Context(), f)
	if err != nil {
		if errors.Is(err, crud.ErrUnknownColumn) {
			return echo.NewHTTPError(http.StatusBadRequest, err.Error())
		}
		return err
	}

	resp := make([]map[string]any, len(rows))
	for i, row := range rows {
		resp[i] = crud.BuildResponse(h.meta, row)
	}

	return c.JSON(http.StatusOK, crud.PaginatedResponse{
		Data:     resp,
		Total:    total,
		Page:     f.Page,
		PageSize: f.PageSize,
	})
}

// GetByID handles GET /api/v1/{table}/:id
func (h *GenericHandler) GetByID(c echo.Context) error {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}

	row, err := h.svc.GetByID(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, crud.ErrNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		return err
	}

	return c.JSON(http.StatusOK, crud.BuildResponse(h.meta, row))
}

// Create handles POST /api/v1/{table}
func (h *GenericHandler) Create(c echo.Context) error {
	var body map[string]any
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	clean, err := crud.ValidateRequest(h.meta, body, true)
	if err != nil {
		var ve *crud.ValidationError
		if errors.As(err, &ve) {
			return c.JSON(http.StatusUnprocessableEntity, map[string]any{
				"error":  err.Error(),
				"code":   "VALIDATION_ERROR",
				"fields": ve.Missing,
			})
		}
		return err
	}

	result, err := h.svc.Create(c.Request().Context(), clean)
	if err != nil {
		return err
	}

	return c.JSON(http.StatusCreated, crud.BuildResponse(h.meta, result))
}

// Update handles PUT /api/v1/{table}/:id
func (h *GenericHandler) Update(c echo.Context) error {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}

	var body map[string]any
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request body")
	}

	clean, err := crud.ValidateRequest(h.meta, body, false)
	if err != nil {
		var ve *crud.ValidationError
		if errors.As(err, &ve) {
			return c.JSON(http.StatusUnprocessableEntity, map[string]any{
				"error":  err.Error(),
				"code":   "VALIDATION_ERROR",
				"fields": ve.Missing,
			})
		}
		return err
	}

	result, err := h.svc.Update(c.Request().Context(), id, clean)
	if err != nil {
		if errors.Is(err, crud.ErrNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		return err
	}

	return c.JSON(http.StatusOK, crud.BuildResponse(h.meta, result))
}

// Delete handles DELETE /api/v1/{table}/:id
// Only mounted for tables with SoftDelete=true or hard-delete tables.
func (h *GenericHandler) Delete(c echo.Context) error {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}

	if err := h.svc.Delete(c.Request().Context(), id); err != nil {
		if errors.Is(err, crud.ErrNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		return err
	}

	return c.NoContent(http.StatusNoContent)
}

// Restore handles POST /api/v1/{table}/:id/restore
// Only mounted for soft-delete tables.
func (h *GenericHandler) Restore(c echo.Context) error {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid id format")
	}

	result, err := h.svc.Restore(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, crud.ErrNotFound) {
			return echo.NewHTTPError(http.StatusNotFound, "not found")
		}
		return err
	}

	return c.JSON(http.StatusOK, crud.BuildResponse(h.meta, result))
}
