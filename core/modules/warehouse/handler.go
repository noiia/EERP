package warehouse

import (
	"errors"
	"net/http"
	"reflect"

	"core/internal/auth"
	"core/orm"

	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
)

// Handler serves the ONE route this module overrides: POST /api/v1/product_variant.
// Every other verb (GET/PUT/DELETE/restore) keeps going through the fully
// generic CRUD handler mounted for every ORM-registered table — same shape
// as modules/crminheritdemo/handler.go, see that file for why this is a
// hand-mounted route rather than a "hook" (no such hook exists in this
// codebase).
type Handler struct {
	variants *orm.Repository[ProductVariant]
	products *orm.Repository[Product]
}

func NewHandler(variants *orm.Repository[ProductVariant], products *orm.Repository[Product]) *Handler {
	return &Handler{variants: variants, products: products}
}

// Create handles POST /api/v1/product_variant. The generic insert every
// other table gets is unchanged (repo.Create, RETURNING *); the two
// customizations:
//
//   - ProductID must reference an existing Product — "a variant can be
//     created only based on an existing product.product" — enforced by
//     actually loading it, not just trusting the caller's uuid.
//   - A blank Name defaults to that Product's own name, so "reference a
//     variant" from a product is a one-field action.
func (h *Handler) Create(c echo.Context) error {
	identity := auth.MustIdentity(c.Request().Context())

	var body ProductVariant
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	product, err := h.products.FindByID(c.Request().Context(), body.ProductID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errorJSON(c, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "product_id must reference an existing product.")
		}
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not look up the product.")
	}
	body.Name = defaultVariantName(body.Name, product.Name)

	created, err := h.variants.Create(c.Request().Context(), body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the variant.")
	}
	return c.JSON(http.StatusCreated, toColumnMap(h.variants, created))
}

// defaultVariantName is pulled out as a pure function (no DB, no HTTP) so the
// behavior is testable on its own — see handler_test.go.
func defaultVariantName(name, productName string) string {
	if name != "" {
		return name
	}
	return productName
}

// toColumnMap mirrors the generic CRUD handler's JSON shape — snake_case db
// column names, not Go field names — using the same public metadata the
// query builders already reflect over (Repository.Meta()).
func toColumnMap[T any](repo *orm.Repository[T], entity T) map[string]any {
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
