package crud

import (
	"fmt"
	"strings"

	"core/orm/internal/registry"
)

// serverGenerated columns are injected by the server, not the client, so they are
// never treated as required-on-create. tenant_id is forced from the caller's
// authenticated identity by the repository (see tenant isolation), so — like the
// id and timestamp columns — clients must not be asked to supply it.
var serverGenerated = map[string]bool{
	"id":         true,
	"created_at": true,
	"updated_at": true,
	"deleted_at": true,
	"tenant_id":  true,
}

// ValidationError holds a list of missing required field names.
type ValidationError struct {
	Missing []string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("missing required fields: %s", strings.Join(e.Missing, ", "))
}

// PaginatedResponse is the uniform envelope for list endpoints.
type PaginatedResponse struct {
	Data     []map[string]any `json:"data"`
	Total    int              `json:"total"`
	Page     int              `json:"page"`
	PageSize int              `json:"page_size"`
}

// ValidateRequest filters body to known non-read-only fields and validates that
// all non-nullable, non-server-generated fields are present on create.
//
// Returns a clean map ready to pass to the service, or *ValidationError on error.
func ValidateRequest(meta registry.TableMeta, body map[string]any, isCreate bool) (map[string]any, error) {
	result := make(map[string]any, len(meta.Fields))
	var missing []string

	for _, f := range meta.Fields {
		if f.ReadOnly {
			continue
		}

		// Accept either the column name or the JSON name.
		val, ok := body[f.Column]
		if !ok {
			val, ok = body[f.Name]
		}

		if ok {
			result[f.Column] = val
		} else if isCreate && !f.Nullable && !serverGenerated[f.Column] {
			missing = append(missing, f.Name)
		}
	}

	if len(missing) > 0 {
		return nil, &ValidationError{Missing: missing}
	}
	return result, nil
}

// BuildResponse maps a raw DB row (keyed by column name) to a response map
// keyed by FieldMeta.Name (the JSON key). Fields not in meta are silently dropped.
func BuildResponse(meta registry.TableMeta, row map[string]any) map[string]any {
	out := make(map[string]any, len(meta.Fields))
	for _, f := range meta.Fields {
		if val, ok := row[f.Column]; ok {
			out[f.Name] = val
		}
	}
	return out
}
