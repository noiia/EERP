package teams

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

const maxNoteSize = 10 << 20

func fileVersion(key string) string {
	return fmt.Sprintf(`"%x"`, sha256.Sum256([]byte(key)))
}

// UpdateNote saves an OpenCloud note (a bare Tiptap JSON document). The version
// from the download's ETag prevents one editor from overwriting another's save.
// Format: https://github.com/opencloud-eu/web/blob/main/packages/web-pkg/src/editor/composables/strategies/tiptapJson.ts
func (h *Handler) UpdateNote(c *echo.Context) error {
	f, _, ok, err := h.teamFile(c)
	if !ok {
		return err
	}
	if !strings.EqualFold(filepath.Ext(f.Name), ".ocnote") {
		return invalid(c, "Only .ocnote files can be edited as notes.")
	}
	data, err := io.ReadAll(io.LimitReader(c.Request().Body, maxNoteSize+1))
	if err != nil {
		return err
	}
	if len(data) > maxNoteSize {
		return errorJSON(c, http.StatusRequestEntityTooLarge, "VALIDATION_ERROR", "The note is too large.")
	}
	var b struct {
		Content json.RawMessage `json:"content"`
		Version string          `json:"version"`
	}
	if err := json.Unmarshal(data, &b); err != nil {
		return invalid(c, "Malformed request body.")
	}
	var doc struct {
		Type    string            `json:"type"`
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(b.Content, &doc); err != nil || doc.Type != "doc" || doc.Content == nil {
		return invalid(c, "The note must contain a Tiptap JSON document.")
	}
	if b.Version == "" {
		return invalid(c, "The note version is required.")
	}
	if b.Version != fileVersion(f.ObjectKey) {
		return noteConflict(c)
	}
	var content bytes.Buffer
	if err := json.Compact(&content, b.Content); err != nil {
		return invalid(c, "The note must contain a Tiptap JSON document.")
	}
	ctx := c.Request().Context()
	previousKey := f.ObjectKey
	f.ObjectKey = fmt.Sprintf("%s/teams/%s", f.TenantID, uuid.New())
	f.Mime, f.Size = "application/json", int64(content.Len())
	if err := h.objects.Put(ctx, f.ObjectKey, f.Mime, f.Size, &content); err != nil {
		return fmt.Errorf("teams: store note: %w", err)
	}
	replaced, err := h.repo.ReplaceFileContent(ctx, f, previousKey)
	if err != nil || !replaced {
		h.deleteObjects(ctx, []string{f.ObjectKey}, "failed note save")
		if err != nil {
			return err
		}
		return noteConflict(c)
	}
	h.deleteObjects(ctx, []string{previousKey}, "note replaced")
	return c.JSON(http.StatusOK, map[string]string{"version": fileVersion(f.ObjectKey)})
}

func noteConflict(c *echo.Context) error {
	return errorJSON(c, http.StatusConflict, "CONFLICT", "This note has changed. Reopen it before saving again.")
}
