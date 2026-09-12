package crminheritdemo

import (
	"net/http"
	"reflect"

	"core/internal/auth"
	"core/orm"

	"github.com/labstack/echo/v4"
)

// Handler serves the ONE route this module overrides: POST /api/v1/crm.
// Every other verb on that table (GET/PUT/DELETE/restore) keeps going
// through the fully generic CRUD handler mounted for every ORM-registered
// table — this is deliberately the ONLY operation crminheritdemo touches.
//
// There is no per-module route-registration hook in this codebase (a Go
// module's Register() only ever calls orm.Register[T]/orm.ExtendSchema — see
// go_module.go); every custom route, generic or not, is wired by hand in
// cmd/app/main.go. This one is mounted AFTER the generic CRUD block so
// Echo's router keeps the later registration for this exact method+path —
// GET/PUT/DELETE/restore on /api/v1/crm are untouched, still generic.
type Handler struct {
	repo *orm.Repository[CRM]
}

func NewHandler(repo *orm.Repository[CRM]) *Handler {
	return &Handler{repo: repo}
}

// Create handles POST /api/v1/crm for this module's extended CRM. It runs
// the SAME insert every other table gets — RETURNING *, id/created_at/
// updated_at from DB defaults, via the public orm.Repository[CRM].Create —
// that's "keep the original operation." The ONLY customization is
// rewordComment, run on the incoming body first.
//
// Bypassing the generic route also bypasses its tenant-scoping (that logic
// lives in an internal package, core/orm/internal/crud, unreachable from
// here) — TenantID has to be forced from the JWT identity by hand, exactly
// like internal/notebook and internal/pictures already do for their own
// dedicated routes.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var body CRM
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID
	body = rewordComment(body)

	created, err := h.repo.Create(c.Request().Context(), body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the record.")
	}
	return c.JSON(http.StatusCreated, toColumnMap(h.repo, created))
}

// rewordComment is the actual override, pulled out as a pure function (no
// DB, no HTTP) so the behavior is testable on its own — see handler_test.go.
// A nil Comment (never supplied) is left alone; there is nothing to reword.
func rewordComment(body CRM) CRM {
	if body.Comment != nil {
		reworded := *body.Comment + " test demo"
		body.Comment = &reworded
	}
	return body
}

// toColumnMap mirrors the generic CRUD handler's JSON shape — snake_case db
// column names, not Go field names — using the SAME public metadata the
// query builders already reflect over (Repository.Meta()). Without this, a
// naive c.JSON(status, created) would marshal Go field names (e.g.
// "TenantID"), and the frontend — which renders this same "crm" entity
// through the generic engine for every OTHER verb — would silently fail to
// reconcile the fields this handler alone produces.
func toColumnMap(repo *orm.Repository[CRM], entity CRM) map[string]any {
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
