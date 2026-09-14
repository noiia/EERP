package attachments

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"regexp"

	"core/internal/auth"
	"core/internal/common"
	"core/internal/pictures"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// Handler serves the dedicated attachment endpoints — same shape as
// internal/pictures/handler.go, scoped to arbitrary files instead of
// images. Mounted behind jwtMw + permMw: the permission middleware derives
// attachments:attachments:read|write from the route, and every query is
// pinned to the caller's tenant. Uploads are multipart and bounded by the
// server-wide request body limit (request_body_limit) — no extra size cap
// here, same as pictures.
//
// The service invariant is ONE attachment per (table, record, field) anchor
// — the file-backed boolean contract (field true ⇔ attachment exists) needs
// exactly one object to point at, so POST replaces any previous attachment
// on the anchor. Unlike pictures, there is deliberately NO mime whitelist —
// "billing of buy" invoices and rent receipts are PDFs today, something else
// tomorrow; the field is generic, not image-shaped.

// anchorNamePattern keeps table/field names shaped like identifiers — see
// pictures/handler.go's identical guard.
var anchorNamePattern = regexp.MustCompile(`^[a-z0-9_]{1,63}$`)

// ObjectStore is pictures.ObjectStore verbatim — attachments reuse the exact
// same S3-backed implementation (pictures.NewS3Store), not a duplicate: the
// object-store layer was already provider/content-agnostic (internal/reports
// reuses it for PDF storage the same way).
type ObjectStore = pictures.ObjectStore

// attachmentStore is the call-site interface the handler needs from the repository.
type attachmentStore interface {
	Create(ctx context.Context, a Attachment) (Attachment, error)
	Update(ctx context.Context, a Attachment, id uuid.UUID) (Attachment, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Attachment, error)
	FindByAnchor(ctx context.Context, tenantID uuid.UUID, table string, recordID uuid.UUID, field string) (Attachment, error)
	Delete(ctx context.Context, tenantID, id uuid.UUID) error
}

type Handler struct {
	store   attachmentStore
	objects ObjectStore
}

// NewHandler constructs the attachments Handler from concrete implementations.
func NewHandler(store *Repository, objects ObjectStore) *Handler {
	return &Handler{store: store, objects: objects}
}

// newHandlerWith constructs a Handler from interface values (used in tests).
func newHandlerWith(store attachmentStore, objects ObjectStore) *Handler {
	return &Handler{store: store, objects: objects}
}

type attachmentResponse struct {
	ID        uuid.UUID `json:"id"`
	TableName string    `json:"table_name"`
	RecordID  uuid.UUID `json:"record_id"`
	Field     string    `json:"field"`
	Filename  string    `json:"filename"`
	Mime      string    `json:"mime"`
	Size      int64     `json:"size"`
}

func toResponse(a Attachment) attachmentResponse {
	return attachmentResponse{
		ID: a.ID, TableName: a.TableName, RecordID: a.RecordID,
		Field: a.Field, Filename: a.Filename, Mime: a.Mime, Size: a.Size,
	}
}

// Upload handles POST /api/v1/attachments — multipart form carrying `file`
// plus the anchor fields table_name / record_id / field. Replaces any
// existing attachment on the anchor: the new object lands first, then the
// row flips to it, then the old object is deleted best-effort (an orphaned
// object is a leak; a row pointing at a missing object would be a lie) —
// identical sequencing to pictures.Handler.Upload.
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
	filename := fileHeader.Filename
	if filename == "" {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "The uploaded file needs a name.")
	}
	fileMime := fileHeader.Header.Get("Content-Type")
	if fileMime == "" {
		fileMime = "application/octet-stream"
	}

	file, err := fileHeader.Open()
	if err != nil {
		return fmt.Errorf("attachments: open upload: %w", err)
	}
	defer func() { _ = file.Close() }()

	key := fmt.Sprintf("%s/%s/%s/%s/%s", identity.TenantID, table, recordID, field, uuid.NewString())
	if err := h.objects.Put(c.Request().Context(), key, fileMime, fileHeader.Size, file); err != nil {
		return fmt.Errorf("attachments: store object: %w", err)
	}

	existing, err := h.store.FindByAnchor(c.Request().Context(), identity.TenantID, table, recordID, field)
	switch {
	case err == nil:
		oldKey := existing.ObjectKey
		existing.ObjectKey, existing.Filename, existing.Mime, existing.Size = key, filename, fileMime, fileHeader.Size
		updated, err := h.store.Update(c.Request().Context(), existing, existing.ID)
		if err != nil {
			return fmt.Errorf("attachments: replace metadata: %w", err)
		}
		if err := h.objects.Delete(c.Request().Context(), oldKey); err != nil {
			common.Logger.Warn("attachments: orphaned object after replace", zap.String("key", oldKey), zap.Error(err))
		}
		return c.JSON(http.StatusCreated, toResponse(updated))
	case errors.Is(err, orm.ErrNotFound):
		created, err := h.store.Create(c.Request().Context(), Attachment{
			TenantID: identity.TenantID, TableName: table, RecordID: recordID,
			Field: field, ObjectKey: key, Filename: filename, Mime: fileMime, Size: fileHeader.Size,
		})
		if err != nil {
			return fmt.Errorf("attachments: create metadata: %w", err)
		}
		return c.JSON(http.StatusCreated, toResponse(created))
	default:
		return fmt.Errorf("attachments: find anchor: %w", err)
	}
}

// Get handles GET /api/v1/attachments/:id — streams the file bytes with a
// download-triggering Content-Disposition carrying the ORIGINAL filename
// (pictures.Handler.Get never sets this: a picture renders inline as <img>,
// an attachment is meant to be saved to disk by name).
func (h *Handler) Get(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	attachment, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such attachment.")
		}
		return fmt.Errorf("attachments: find: %w", err)
	}

	body, contentType, err := h.objects.Get(c.Request().Context(), attachment.ObjectKey)
	if err != nil {
		return fmt.Errorf("attachments: read object: %w", err)
	}
	defer func() { _ = body.Close() }()
	if attachment.Mime != "" {
		contentType = attachment.Mime
	}
	c.Response().Header().Set("Content-Disposition", mime.FormatMediaType(
		"attachment", map[string]string{"filename": attachment.Filename}))
	return c.Stream(http.StatusOK, contentType, body)
}

// Find handles GET /api/v1/attachments?table=&record=&field= — resolves the
// anchor to its attachment metadata (the widget asks "does this field have a
// file, and under which id/name?"). 404 when the anchor has none.
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

	attachment, err := h.store.FindByAnchor(c.Request().Context(), identity.TenantID, table, recordID, field)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No attachment on this field.")
		}
		return fmt.Errorf("attachments: find anchor: %w", err)
	}
	return c.JSON(http.StatusOK, toResponse(attachment))
}

// Delete handles DELETE /api/v1/attachments/:id. The row goes first (the
// boolean contract must never see a row without an object), then the object
// — best-effort: an orphaned object is a storage leak, not an integrity bug.
func (h *Handler) Delete(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "id must be a UUID.")
	}
	attachment, err := h.store.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "No such attachment.")
		}
		return fmt.Errorf("attachments: find: %w", err)
	}

	if err := h.store.Delete(c.Request().Context(), identity.TenantID, id); err != nil {
		return fmt.Errorf("attachments: delete metadata: %w", err)
	}
	if err := h.objects.Delete(c.Request().Context(), attachment.ObjectKey); err != nil {
		common.Logger.Warn("attachments: orphaned object after delete", zap.String("key", attachment.ObjectKey), zap.Error(err))
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
