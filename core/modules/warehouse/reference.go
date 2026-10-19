package warehouse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"core/internal/auth"
	"core/internal/settings"
	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// Product references, automatic or typed. The warehouse app setting
// auto_reference (Settings -> Apps -> Warehouse, default ON) decides:
//
//   - on: a new product takes the next number of the tenant's product
//     sequence ("PRD-00001") whatever the client sent, and an edit can't
//     change it — the form shows the field read-only;
//   - off: the reference is whatever the user types, editable.
//
// The middlewares below sit in front of the generic POST/PUT
// /api/v1/product; the create one also fills the optional text columns a
// client may leave out (description, reference), which the generic create
// would otherwise refuse as "required fields missing".

// SettingsKey holds the warehouse app's workspace settings as JSON, in
// app_settings' tenant-wide slot (company_id = uuid.Nil).
const SettingsKey = "warehouse.settings"

// Settings are the warehouse app's workspace settings.
type Settings struct {
	// AutoReference: product references come from the sequence. Default true.
	AutoReference bool `json:"auto_reference"`
}

// settingsFile is the stored shape: a pointer, so "never saved" reads as
// the default (true) rather than false.
type settingsFile struct {
	AutoReference *bool `json:"auto_reference"`
}

// LoadSettings reads the tenant's settings; absent parts take their default.
func LoadSettings(ctx context.Context, store *settings.Repository, tenant uuid.UUID) (Settings, error) {
	s := Settings{AutoReference: true}
	raw, ok, err := store.Get(ctx, tenant, uuid.Nil, SettingsKey)
	if err != nil || !ok || raw == "" {
		return s, err
	}
	var f settingsFile
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		return s, nil // unreadable: keep the defaults rather than fail a write
	}
	if f.AutoReference != nil {
		s.AutoReference = *f.AutoReference
	}
	return s, nil
}

const (
	referencePrefix = "PRD"
	sequenceProduct = "product"
)

// nextReference takes the next product reference of the tenant's sequence:
// one atomic statement, so concurrent creates never share one. Its first use
// starts after the highest "PRD-<n>" reference already in the table, so a
// reference typed before the sequence existed is never handed out again.
func nextReference(ctx context.Context, ex orm.Executor, tenant uuid.UUID) (string, error) {
	pattern := `^` + referencePrefix + `-(\d+)$`
	var n int
	err := ex.QueryRow(ctx, `
		INSERT INTO warehouse_sequence (tenant_id, kind, last)
		SELECT $1, $2, COALESCE(MAX(substring(reference from $3)::int), 0) + 1
		  FROM product WHERE tenant_id = $1 AND reference ~ $3
		ON CONFLICT (tenant_id, kind) DO UPDATE SET last = warehouse_sequence.last + 1
		RETURNING last`, tenant, sequenceProduct, pattern).Scan(&n)
	if err != nil {
		return "", fmt.Errorf("warehouse: next product reference: %w", err)
	}
	return fmt.Sprintf("%s-%05d", referencePrefix, n), nil
}

// ProductHandler serves the warehouse settings and the reference middlewares.
type ProductHandler struct {
	db            *orm.DB
	settingsStore *settings.Repository
}

func NewProductHandler(db *orm.DB, settingsStore *settings.Repository) *ProductHandler {
	return &ProductHandler{db: db, settingsStore: settingsStore}
}

func readBody(c *echo.Context) (map[string]any, error) {
	raw, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return nil, errors.New("malformed body")
	}
	return body, nil
}

func writeBody(c *echo.Context, body map[string]any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	c.Request().Body = io.NopCloser(bytes.NewReader(raw))
	c.Request().ContentLength = int64(len(raw))
	return nil
}

// OnCreate wraps the generic POST /api/v1/product.
func (h *ProductHandler) OnCreate(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		identity := auth.MustIdentity(ctx)
		body, err := readBody(c)
		if err != nil {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
		}
		// Optional text the form may not send: never "required".
		for _, col := range []string{"description", "reference"} {
			if v, ok := body[col]; !ok || v == nil {
				body[col] = ""
			}
		}
		s, err := LoadSettings(ctx, h.settingsStore, identity.TenantID)
		if err != nil {
			return err
		}
		if s.AutoReference {
			ref, err := nextReference(ctx, h.db, identity.TenantID)
			if err != nil {
				return err
			}
			body["reference"] = ref
		}
		if err := writeBody(c, body); err != nil {
			return err
		}
		return next(c)
	}
}

// OnUpdate wraps the generic PUT /api/v1/product/:id: in auto mode the
// stored reference stays, whatever the body says.
func (h *ProductHandler) OnUpdate(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c *echo.Context) error {
		ctx := c.Request().Context()
		identity := auth.MustIdentity(ctx)
		s, err := LoadSettings(ctx, h.settingsStore, identity.TenantID)
		if err != nil {
			return err
		}
		if !s.AutoReference {
			return next(c)
		}
		id, err := echo.PathParam[uuid.UUID](c, "id")
		if err != nil {
			return next(c) // the generic handler answers the malformed id
		}
		body, err := readBody(c)
		if err != nil {
			return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
		}
		var ref string
		err = h.db.QueryRow(ctx, `SELECT reference FROM product WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
			id, identity.TenantID).Scan(&ref)
		if errors.Is(err, orm.ErrNotFound) {
			return next(c) // the generic handler answers the 404
		}
		if err != nil {
			return err
		}
		body["reference"] = ref
		if err := writeBody(c, body); err != nil {
			return err
		}
		return next(c)
	}
}

// GetSettings handles GET /api/v1/settings/warehouse (settings:warehouse:read,
// route-derived) — also the product form's context (formContext), which
// makes the reference read-only in auto mode.
func (h *ProductHandler) GetSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)
	s, err := LoadSettings(ctx, h.settingsStore, identity.TenantID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, s)
}

// PutSettings handles PUT /api/v1/settings/warehouse (settings:warehouse:write).
func (h *ProductHandler) PutSettings(c *echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)
	var in settingsFile
	if err := json.NewDecoder(c.Request().Body).Decode(&in); err != nil || in.AutoReference == nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "auto_reference (true or false) is required.")
	}
	raw, _ := json.Marshal(in)
	if err := h.settingsStore.Set(ctx, identity.TenantID, uuid.Nil, SettingsKey, string(raw)); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, Settings{AutoReference: *in.AutoReference})
}
