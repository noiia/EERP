package pictures

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"core/internal/auth"
	"core/internal/common"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// Handler serves the dedicated picture endpoints. Mounted behind jwtMw + permMw:
// the permission middleware derives pictures:pictures:read|write from the route,
// and every query is pinned to the caller's tenant. Uploads are multipart and
// bounded by the server-wide request body limit (request_body_limit).
//
// The service invariant is ONE picture per (table, record, field) anchor — the
// picture-backed boolean contract (field true ⇔ picture exists) needs exactly
// one object to point at, so POST replaces any previous picture on the anchor.

// anchorNamePattern keeps table/field names shaped like identifiers — they end
// up in object keys and DB rows, never as SQL identifiers, but junk stays out.
var anchorNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,63}$`)

// allowedMimes is the upload whitelist. Signatures export image/png; photos
// arrive as JPEG/PNG/WebP. Anything else is rejected up front.
var allowedMimes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
}

// pictureStore is the call-site interface the handler needs from the repository.
type pictureStore interface {
	Create(ctx context.Context, p Picture) (Picture, error)
	Update(ctx context.Context, p Picture, id uuid.UUID) (Picture, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Picture, error)
	FindByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID, field string) (Picture, error)
	Delete(ctx context.Context, tenantID, id uuid.UUID) error
}

type Handler struct {
	store   pictureStore
	objects ObjectStore
}

// NewHandler constructs the pictures Handler from concrete implementations.
func NewHandler(store *Repository, objects ObjectStore) *Handler {
	return &Handler{store: store, objects: objects}
}

// newHandlerWith constructs a Handler from interface values (used in tests).
func newHandlerWith(store pictureStore, objects ObjectStore) *Handler {
	return &Handler{store: store, objects: objects}
}

type pictureResponse struct {
	ID        uuid.UUID `json:"id"`
	TableName string    `json:"table_name"`
	RecordID  uuid.UUID `json:"record_id"`
	Field     string    `json:"field"`
	Mime      string    `json:"mime"`
	Size      int64     `json:"size"`
}

func toResponse(p Picture) pictureResponse {
	return pictureResponse{
		ID: p.ID, TableName: p.TableName, RecordID: p.RecordID,
		Field: p.Field, Mime: p.Mime, Size: p.Size,
	}
}

// Upload handles POST /api/v1/pictures — multipart form carrying `file` plus
// the anchor fields table_name / record_id / field. Replaces any existing
// picture on the anchor: the new object lands first, then the row flips to it,
// then the old object is deleted best-effort (an orphaned object is a leak; a
// row pointing at a missing object would be a lie).
func (h *Handler) Upload(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	table := c.FormValue("table_name")
	field := c.FormValue("field")
	if !anchorNamePattern.MatchString(table) || !anchorNamePattern.MatchString(field) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"table_name and field must be lowercase identifiers.")
	}
	recordID, err := uuid.Parse(c.FormValue("record_id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "record_id must be a UUID.")
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "A `file` part is required.")
	}
	mime := fileHeader.Header.Get("Content-Type")
	if !allowedMimes[mime] {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"file must be image/png, image/jpeg or image/webp.")
	}

	file, err := fileHeader.Open()
	if err != nil {
		return fmt.Errorf("pictures: open upload: %w", err)
	}
	defer func() { _ = file.Close() }()

	key := fmt.Sprintf("%s/%s/%s/%s/%s", identity.TenantID, table, recordID, field, uuid.NewString())
	if err := h.objects.Put(c.Request().Context(), key, mime, fileHeader.Size, file); err != nil {
		return fmt.Errorf("pictures: store object: %w", err)
	}

	existing, err := h.store.FindByAnchor(c.Request().Context(), identity.TenantID, table, recordID, field)
	switch {
	case err == nil:
		oldKey := existing.ObjectKey
		existing.ObjectKey, existing.Mime, existing.Size = key, mime, fileHeader.Size
		updated, err := h.store.Update(c.Request().Context(), existing, existing.ID)
		if err != nil {
			return fmt.Errorf("pictures: replace metadata: %w", err)
		}
		if err := h.objects.Delete(c.Request().Context(), oldKey); err != nil {
			common.Logger.Warn("pictures: orphaned object after replace", zap.String("key", oldKey), zap.Error(err))
		}
		return c.JSON(http.StatusCreated, toResponse(updated))
	case errors.Is(err, orm.ErrNotFound):
		created, err := h.store.Create(c.Request().Context(), Picture{
			TenantID: identity.TenantID, TableName: table, RecordID: recordID,
			Field: field, ObjectKey: key, Mime: mime, Size: fileHeader.Size,
		})
		if err != nil {
			return fmt.Errorf("pictures: create metadata: %w", err)
		}
		return c.JSON(http.StatusCreated, toResponse(created))
	default:
		return fmt.Errorf("pictures: find anchor: %w", err)
	}
}

// Get handles GET /api/v1/pictures/:id — streams the image bytes.
func (h *Handler) Get(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	picture, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such picture.")
		}
		return fmt.Errorf("pictures: find: %w", err)
	}

	body, contentType, err := h.objects.Get(c.Request().Context(), picture.ObjectKey)
	if err != nil {
		return fmt.Errorf("pictures: read object: %w", err)
	}
	defer func() { _ = body.Close() }()
	if picture.Mime != "" {
		contentType = picture.Mime
	}
	return c.Stream(http.StatusOK, contentType, body)
}

// Find handles GET /api/v1/pictures?table=&record=&field= — resolves the
// anchor to its picture metadata (the widget asks "does this field have a
// picture, and under which id?"). 404 when the anchor has none.
func (h *Handler) Find(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	table := c.QueryParam("table")
	field := c.QueryParam("field")
	if !anchorNamePattern.MatchString(table) || !anchorNamePattern.MatchString(field) {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR",
			"table and field must be lowercase identifiers.")
	}
	recordID, err := uuid.Parse(c.QueryParam("record"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "record must be a UUID.")
	}

	picture, err := h.store.FindByAnchor(c.Request().Context(), identity.TenantID, table, recordID, field)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No picture on this field.")
		}
		return fmt.Errorf("pictures: find anchor: %w", err)
	}
	return c.JSON(http.StatusOK, toResponse(picture))
}

// Delete handles DELETE /api/v1/pictures/:id. The row goes first (the boolean
// contract must never see a row without an object), then the object —
// best-effort: an orphaned object is a storage leak, not an integrity bug.
func (h *Handler) Delete(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	picture, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such picture.")
		}
		return fmt.Errorf("pictures: find: %w", err)
	}

	if err := h.store.Delete(c.Request().Context(), identity.TenantID, id); err != nil {
		return fmt.Errorf("pictures: delete metadata: %w", err)
	}
	if err := h.objects.Delete(c.Request().Context(), picture.ObjectKey); err != nil {
		common.Logger.Warn("pictures: orphaned object after delete", zap.String("key", picture.ObjectKey), zap.Error(err))
	}
	return c.NoContent(http.StatusNoContent)
}

func errorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
