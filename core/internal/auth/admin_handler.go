package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"core/orm"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
)

// AdminHandler serves the dedicated users/roles management endpoints. The auth
// tables are excluded from the generic CRUD surface on purpose (privilege
// escalation risk), so this handler is the ONLY HTTP write path to them: it
// whitelists the mutable fields (a user's email; a role's name/description),
// pins every query to the caller's tenant, and never exposes password_hash.
// Routing decides authorization: mounted under /api/v1/users and /api/v1/roles
// behind the permission middleware, which derives users:users:* / roles:roles:*.
//
// Create is supported for both (POST derives the same :write permission); a new
// user starts LOCKED — no password, so no login — until a dedicated credential
// flow exists. Deletion and role/permission assignment stay out until they get
// their own audited, purpose-built flows.

// ── Call-site interfaces (defined here, not at implementation) ────────────────

type adminUserStore interface {
	ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]Users, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Users, error)
	CreateUser(ctx context.Context, tenantID uuid.UUID, email string) (Users, error)
	UpdateEmail(ctx context.Context, tenantID, id uuid.UUID, email string) (Users, error)
}

type adminRoleStore interface {
	ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]Roles, error)
	FindInTenant(ctx context.Context, tenantID, id uuid.UUID) (Roles, error)
	CreateRole(ctx context.Context, tenantID uuid.UUID, name, description string, technicalName *string) (Roles, error)
	UpdateRole(ctx context.Context, tenantID, id uuid.UUID, name, description string, technicalName *string) (Roles, error)
}

// AdminHandler carries the tenant-scoped stores; see the package comment above.
type AdminHandler struct {
	users adminUserStore
	roles adminRoleStore
}

// NewAdminHandler constructs an AdminHandler from the concrete repositories.
func NewAdminHandler(users *UserRepository, roles *RoleRepository) *AdminHandler {
	return &AdminHandler{users: users, roles: roles}
}

// newAdminHandlerWith constructs an AdminHandler from interface values (tests).
func newAdminHandlerWith(users adminUserStore, roles adminRoleStore) *AdminHandler {
	return &AdminHandler{users: users, roles: roles}
}

// ── Response shapes ───────────────────────────────────────────────────────────
// DTOs, not the models: password_hash and tenant_id must never serialize, and the
// JSON keys are the contract the frontend descriptors (field names) rely on.

type adminUserResponse struct {
	ID              uuid.UUID `json:"id"`
	Email           string    `json:"email"`
	PreferredLocale *string   `json:"preferred_locale"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func toUserResponse(u Users) adminUserResponse {
	return adminUserResponse{
		ID:              u.ID,
		Email:           u.Email,
		PreferredLocale: u.PreferredLocale,
		CreatedAt:       u.CreatedAt,
		UpdatedAt:       u.UpdatedAt,
	}
}

type adminRoleResponse struct {
	ID            uuid.UUID `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	TechnicalName string    `json:"technical_name"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func toRoleResponse(r Roles) adminRoleResponse {
	technicalName := ""
	if r.TechnicalName != nil {
		technicalName = *r.TechnicalName
	}
	return adminRoleResponse{
		ID:            r.ID,
		Name:          r.Name,
		Description:   r.Description,
		TechnicalName: technicalName,
		CreatedAt:     r.CreatedAt,
		UpdatedAt:     r.UpdatedAt,
	}
}

// listEnvelope mirrors the generic CRUD list shape ({data, total}) so the
// frontend's ApiClient consumes these lists exactly like any entity list.
type listEnvelope struct {
	Data  any `json:"data"`
	Total int `json:"total"`
}

// ── Users ─────────────────────────────────────────────────────────────────────

// ListUsers handles GET /api/v1/users.
func (h *AdminHandler) ListUsers(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	users, err := h.users.ListByTenant(c.Request().Context(), identity.TenantID)
	if err != nil {
		return fmt.Errorf("admin: list users: %w", err)
	}
	data := make([]adminUserResponse, 0, len(users))
	for _, u := range users {
		data = append(data, toUserResponse(u))
	}
	return c.JSON(http.StatusOK, listEnvelope{Data: data, Total: len(data)})
}

// CreateUser handles POST /api/v1/users. The body carries only the email; the
// account is created locked (see UserRepository.CreateUser) in the caller's tenant.
func (h *AdminHandler) CreateUser(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	var req struct {
		Email string `json:"email"`
	}
	if err := c.Bind(&req); err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	email := strings.TrimSpace(req.Email)
	if !validEmail(email) {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "email must be a valid address.")
	}

	created, err := h.users.CreateUser(c.Request().Context(), identity.TenantID, email)
	if err != nil {
		return fmt.Errorf("admin: create user: %w", err)
	}
	return c.JSON(http.StatusCreated, toUserResponse(created))
}

// GetUser handles GET /api/v1/users/:id.
func (h *AdminHandler) GetUser(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid user id.")
	}
	u, err := h.users.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return adminErrorJSON(c, http.StatusNotFound, "NOT_FOUND", "User not found.")
		}
		return fmt.Errorf("admin: get user: %w", err)
	}
	return c.JSON(http.StatusOK, toUserResponse(u))
}

// UpdateUser handles PUT /api/v1/users/:id. Only the email is writable — every
// other field in the body (id, timestamps, locale, …) is ignored.
func (h *AdminHandler) UpdateUser(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid user id.")
	}
	var req struct {
		Email string `json:"email"`
	}
	if err := c.Bind(&req); err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	email := strings.TrimSpace(req.Email)
	if !validEmail(email) {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "email must be a valid address.")
	}

	updated, err := h.users.UpdateEmail(c.Request().Context(), identity.TenantID, id, email)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return adminErrorJSON(c, http.StatusNotFound, "NOT_FOUND", "User not found.")
		}
		return fmt.Errorf("admin: update user: %w", err)
	}
	return c.JSON(http.StatusOK, toUserResponse(updated))
}

// ── Roles ─────────────────────────────────────────────────────────────────────

// ListRoles handles GET /api/v1/roles.
func (h *AdminHandler) ListRoles(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	roles, err := h.roles.ListByTenant(c.Request().Context(), identity.TenantID)
	if err != nil {
		return fmt.Errorf("admin: list roles: %w", err)
	}
	data := make([]adminRoleResponse, 0, len(roles))
	for _, r := range roles {
		data = append(data, toRoleResponse(r))
	}
	return c.JSON(http.StatusOK, listEnvelope{Data: data, Total: len(data)})
}

// CreateRole handles POST /api/v1/roles. The new role starts with no grants.
func (h *AdminHandler) CreateRole(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	var req struct {
		Name          string `json:"name"`
		Description   string `json:"description"`
		TechnicalName string `json:"technical_name"`
	}
	if err := c.Bind(&req); err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	name := strings.TrimSpace(req.Name)
	technicalName := strings.TrimSpace(req.TechnicalName)
	if msg := validateRole(name, req.Description, technicalName); msg != "" {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
	}

	created, err := h.roles.CreateRole(c.Request().Context(), identity.TenantID, name, strings.TrimSpace(req.Description), nilIfEmpty(technicalName))
	if err != nil {
		if errors.Is(err, ErrDuplicateTechnicalName) {
			return adminErrorJSON(c, http.StatusConflict, "CONFLICT", "A role with that technical name already exists.")
		}
		return fmt.Errorf("admin: create role: %w", err)
	}
	return c.JSON(http.StatusCreated, toRoleResponse(created))
}

// GetRole handles GET /api/v1/roles/:id.
func (h *AdminHandler) GetRole(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid role id.")
	}
	role, err := h.roles.FindInTenant(c.Request().Context(), identity.TenantID, id)
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return adminErrorJSON(c, http.StatusNotFound, "NOT_FOUND", "Role not found.")
		}
		return fmt.Errorf("admin: get role: %w", err)
	}
	return c.JSON(http.StatusOK, toRoleResponse(role))
}

// UpdateRole handles PUT /api/v1/roles/:id. Name, description, and
// technical_name are the only writable fields — permission grants stay with
// their own audited flows.
func (h *AdminHandler) UpdateRole(c echo.Context) error {
	identity := MustIdentity(c.Request().Context())

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid role id.")
	}
	var req struct {
		Name          string `json:"name"`
		Description   string `json:"description"`
		TechnicalName string `json:"technical_name"`
	}
	if err := c.Bind(&req); err != nil {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	name := strings.TrimSpace(req.Name)
	technicalName := strings.TrimSpace(req.TechnicalName)
	if msg := validateRole(name, req.Description, technicalName); msg != "" {
		return adminErrorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", msg)
	}

	updated, err := h.roles.UpdateRole(c.Request().Context(), identity.TenantID, id, name, strings.TrimSpace(req.Description), nilIfEmpty(technicalName))
	if err != nil {
		if errors.Is(err, orm.ErrNotFound) {
			return adminErrorJSON(c, http.StatusNotFound, "NOT_FOUND", "Role not found.")
		}
		if errors.Is(err, ErrDuplicateTechnicalName) {
			return adminErrorJSON(c, http.StatusConflict, "CONFLICT", "A role with that technical name already exists.")
		}
		return fmt.Errorf("admin: update role: %w", err)
	}
	return c.JSON(http.StatusOK, toRoleResponse(updated))
}

// ── helpers ───────────────────────────────────────────────────────────────────

// validEmail keeps junk out of the column: a non-edge '@', sane length. Real
// deliverability is not this handler's problem.
func validEmail(email string) bool {
	return len(email) >= 3 && len(email) <= 254 && strings.Contains(email[1:len(email)-1], "@")
}

// validateRole returns the validation message for a trimmed name +
// description + technical name, or "" when all are acceptable. No charset
// validation on technicalName — ponytail: slug regex skipped, add if a bad
// value causes a real support issue.
func validateRole(name, description, technicalName string) string {
	if name == "" || len(name) > 100 {
		return "name is required (max 100 characters)."
	}
	if len(description) > 500 {
		return "description too long (max 500 characters)."
	}
	if len(technicalName) > 100 {
		return "technical_name too long (max 100 characters)."
	}
	return ""
}

// nilIfEmpty returns nil for "" and &s otherwise — Roles.TechnicalName is
// nullable so an unset technical name doesn't collide in the unique index.
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func adminErrorJSON(c echo.Context, status int, code, msg string) error {
	return c.JSON(status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    msg,
			"request_id": c.Response().Header().Get(echo.HeaderXRequestID),
		},
	})
}
