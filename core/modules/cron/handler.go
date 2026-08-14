package cron

import (
	"net/http"
	"reflect"

	"core/internal/auth"
	"core/internal/cron"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// defaultHistoryRetentionYears seeds a freshly-created cron's own retention
// override so an admin sees a real number on the form immediately, not a
// misleading 0 (which internal/cron's retention sweep already treats as
// "use the default" — this is purely a form-UX nicety, not a correctness
// requirement).
const defaultHistoryRetentionYears = 1

// Handler serves the two routes this module overrides for cron: Create and
// Update. GET (list/get)/DELETE stay fully generic. Every mutation needs
// interception because ActionCode — the form's read-only "Code" notebook
// page — must be (re)resolved from the Action registry whenever ActionID
// is set or changes; the generic CRUD surface has no before-write hook for
// that (mirrors modules/crminheritdemo/handler.go's Create override and
// modules/sale/handler.go's Update override exactly).
type Handler struct {
	repo *orm.Repository[cron.Cron]
}

func NewHandler(repo *orm.Repository[cron.Cron]) *Handler {
	return &Handler{repo: repo}
}

// Create handles POST /api/v1/cron.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var body cron.Cron
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID
	if body.Status == "" {
		body.Status = "deactivated"
	}
	if body.HistoryRetentionYears <= 0 {
		body.HistoryRetentionYears = defaultHistoryRetentionYears
	}
	body.ActionCode = resolveActionCode(body.ActionID)

	created, err := h.repo.Create(c.Request().Context(), body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the cron.")
	}
	return c.JSON(http.StatusCreated, toColumnMap(h.repo, created))
}

// Update handles PUT /api/v1/cron/:id. Partial-update semantics for the
// fields that could plausibly be "unchanged" via a zero value on the wire
// (Name/ActionID/Status): a body that omits them keeps the existing value,
// same posture modules/sale/handler.go's Update takes for VariantID/Quantity.
// ExecutionDate/RunAsUserID/HistoryRetentionYears always take the body's
// value verbatim — nil-ing them out is a legitimate edit (clearing a
// schedule or a run-as user), so there is no "0 means unchanged" for them.
func (h *Handler) Update(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}
	existing, err := h.repo.FindByID(c.Request().Context(), id)
	if err != nil {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Cron not found.")
	}

	var body cron.Cron
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	merged := existing
	merged.TenantID = identity.TenantID
	if body.Name != "" {
		merged.Name = body.Name
	}
	if body.ActionID != "" {
		merged.ActionID = body.ActionID
	}
	if body.Status != "" {
		merged.Status = body.Status
	}
	merged.ExecutionDate = body.ExecutionDate
	merged.RunAsUserID = body.RunAsUserID
	if body.HistoryRetentionYears > 0 {
		merged.HistoryRetentionYears = body.HistoryRetentionYears
	}
	merged.ActionCode = resolveActionCode(merged.ActionID)

	updated, err := h.repo.Update(c.Request().Context(), merged, id)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the cron.")
	}
	return c.JSON(http.StatusOK, toColumnMap(h.repo, updated))
}

// resolveActionCode looks up actionID in the registry and returns its
// Source, or a clear placeholder when the id doesn't (yet, or anymore)
// match a registered Action — never an empty string, so the form's
// read-only Code page always shows something explaining the state instead
// of looking broken/blank.
func resolveActionCode(actionID string) string {
	if actionID == "" {
		return ""
	}
	action, ok := cron.Get(actionID)
	if !ok {
		return "// No action is registered under id \"" + actionID + "\"."
	}
	return action.Source
}

// toColumnMap mirrors the generic CRUD handler's JSON shape — snake_case db
// column names — using the same public metadata the query builders reflect
// over (Repository.Meta()). See modules/crminheritdemo/handler.go's twin
// helper for the full rationale.
func toColumnMap(repo *orm.Repository[cron.Cron], entity cron.Cron) map[string]any {
	meta := repo.Meta()
	v := reflect.ValueOf(entity)
	out := make(map[string]any, len(meta.Fields))
	for _, f := range meta.Fields {
		out[f.Column] = f.FieldValue(v).Interface()
	}
	return out
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
