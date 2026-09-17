package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"

	"core/internal/auth"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
)

// grantableRights is the subset of AccountRoleTypes names that translate into
// a real role_permissions grant. "deny" is deliberately excluded — it IS the
// absence of a grant, not a separate mechanism (RoleViewPermission's own doc
// comment; seed.go's adminGrantedRightNames already treats it the same way),
// so ticking it on a view row grants nothing.
var grantableRights = [3]string{"read", "write", "delete"}

// RightsHandler overrides role_view_permission[_right]'s Create/Update/Delete
// so the Rights UI (Settings → Users → Roles → a view's rights) actually
// grants real access instead of only ever writing to the display-only
// catalog table RoleViewPermission's own doc comment names as "not yet
// consulted by any permission check" — this closes that gap by keeping
// role_permissions (what PermissionRepository.Has actually reads) in sync
// with whatever the Rights table currently shows. GET/list stay fully
// generic on both tables.
//
// role_view_permission's own Create (CreateViewPermission) defaults a
// freshly added view to read+write+delete already tagged on — an admin
// adding a view to a role overwhelmingly wants it usable immediately, not a
// blank row they then have to tag three times by hand; "deny" is never a
// default (same posture adminGrantedRightNames already takes for the seeded
// Admin role). It's still just a starting point: every one of those three
// tags can be removed, and "deny" added, exactly like any other tag via
// CreateRight/DeleteRight below.
//
// Every lookup-by-id below checks the resolved row's own TenantID against
// the caller's before trusting it — Repository.FindByID has no tenant
// filter of its own (that scoping lives in the generic CRUD service this
// handler bypasses), so skipping the check would let a caller in one tenant
// grant/revoke role_permissions on a role in ANOTHER tenant by guessing or
// observing a role_view_permission[_right] id.
type RightsHandler struct {
	db        *orm.DB
	viewPerms *orm.Repository[auth.RoleViewPermission]
	rights    *orm.Repository[auth.RoleViewPermissionRight]
	perms     *orm.Repository[auth.Permissions]
	permRepo  *auth.PermissionRepository
}

func NewRightsHandler(db *orm.DB, permRepo *auth.PermissionRepository) *RightsHandler {
	return &RightsHandler{
		db:        db,
		viewPerms: orm.MustRepo[auth.RoleViewPermission](db),
		rights:    orm.MustRepo[auth.RoleViewPermissionRight](db),
		perms:     orm.MustRepo[auth.Permissions](db),
		permRepo:  permRepo,
	}
}

// CreateViewPermission handles POST /api/v1/role_view_permission — adding a
// view to a role's Rights table. Defaults it to read+write+delete already
// tagged on (see this type's own doc comment) and grants those immediately
// via reconcile, rather than leaving a blank row that does nothing until an
// admin manually tags it three times.
func (h *RightsHandler) CreateViewPermission(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	var body auth.RoleViewPermission
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	created, err := h.viewPerms.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the role view.")
	}

	// A brand-new tenant, or one that predates RightsHandler entirely, may
	// have zero account_role_types rows — ensure the catalog this default
	// draws from actually exists before querying it (idempotent, see its own
	// doc comment; also self-healed for every known tenant at boot).
	if err := auth.EnsureAccountRoleTypes(ctx, h.db, identity.TenantID); err != nil {
		return fmt.Errorf("auth: default rights: %w", err)
	}
	rows, err := h.db.Query(ctx, `
		SELECT id, name FROM account_role_types
		WHERE tenant_id = $1 AND name = ANY($2) AND deleted_at IS NULL
	`, identity.TenantID, grantableRights[:])
	if err != nil {
		return fmt.Errorf("auth: default rights: query account role types: %w", err)
	}
	var toTag []struct {
		id   uuid.UUID
		name string
	}
	for rows.Next() {
		var row struct {
			id   uuid.UUID
			name string
		}
		if err := rows.Scan(&row.id, &row.name); err != nil {
			rows.Close()
			return fmt.Errorf("auth: default rights: scan: %w", err)
		}
		toTag = append(toTag, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("auth: default rights: %w", err)
	}
	for _, rt := range toTag {
		right := auth.RoleViewPermissionRight{
			BaseModel:            model.BaseModel{TenantID: identity.TenantID},
			RoleViewPermissionID: created.ID,
			AccountRoleTypeID:    rt.id,
		}
		if _, err := h.rights.Create(ctx, right); err != nil {
			return fmt.Errorf("auth: default rights: tag %s: %w", rt.name, err)
		}
	}

	if err := h.reconcile(ctx, created.RoleID, created.Entity); err != nil {
		return fmt.Errorf("auth: reconcile after view create: %w", err)
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.viewPerms, created))
}

// UpdateViewPermission handles PUT /api/v1/role_view_permission/:id.
// Reconciles role_permissions for the OLD (role,entity) pair — in case
// either changed — and the NEW one, so a role's real access never drifts
// from what its Rights table shows.
func (h *RightsHandler) UpdateViewPermission(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}
	existing, err := h.viewPerms.FindByID(ctx, id)
	if err != nil || existing.TenantID != identity.TenantID {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Role view not found.")
	}

	var body auth.RoleViewPermission
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}

	merged := existing
	merged.TenantID = identity.TenantID
	if body.RoleID != uuid.Nil {
		merged.RoleID = body.RoleID
	}
	if body.Entity != "" {
		merged.Entity = body.Entity
	}

	updated, err := h.viewPerms.Update(ctx, merged, id)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not update the role view.")
	}

	if err := h.reconcile(ctx, existing.RoleID, existing.Entity); err != nil {
		return fmt.Errorf("auth: reconcile after view update: %w", err)
	}
	if updated.RoleID != existing.RoleID || updated.Entity != existing.Entity {
		if err := h.reconcile(ctx, updated.RoleID, updated.Entity); err != nil {
			return fmt.Errorf("auth: reconcile after view update: %w", err)
		}
	}

	return c.JSON(http.StatusOK, toColumnMap(h.viewPerms, updated))
}

// DeleteViewPermission handles DELETE /api/v1/role_view_permission/:id.
// Removing an entity from a role's Views table must revoke whatever real
// access it granted, not just stop showing it in the UI — after the
// soft-delete, reconcile finds no active row left for (role,entity), so
// every grantable right on it gets revoked.
func (h *RightsHandler) DeleteViewPermission(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}
	existing, err := h.viewPerms.FindByID(ctx, id)
	if err != nil || existing.TenantID != identity.TenantID {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Role view not found.")
	}

	if _, err := h.viewPerms.Delete(ctx, id); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not delete the role view.")
	}
	if err := h.reconcile(ctx, existing.RoleID, existing.Entity); err != nil {
		return fmt.Errorf("auth: reconcile after view delete: %w", err)
	}

	return c.NoContent(http.StatusNoContent)
}

// CreateRight handles POST /api/v1/role_view_permission_right — the many2many
// tags widget tagging one deny/read/write/delete right onto a role's view
// row. This is the actual moment a real grant should appear.
func (h *RightsHandler) CreateRight(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	var body auth.RoleViewPermissionRight
	if err := c.Bind(&body); err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Malformed request body.")
	}
	body.TenantID = identity.TenantID

	parent, err := h.viewPerms.FindByID(ctx, body.RoleViewPermissionID)
	if err != nil || parent.TenantID != identity.TenantID {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "Unknown role view.")
	}

	created, err := h.rights.Create(ctx, body)
	if err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not create the right.")
	}
	if err := h.reconcile(ctx, parent.RoleID, parent.Entity); err != nil {
		return fmt.Errorf("auth: reconcile after right create: %w", err)
	}

	return c.JSON(http.StatusCreated, toColumnMap(h.rights, created))
}

// DeleteRight handles DELETE /api/v1/role_view_permission_right/:id —
// untagging a right revokes the matching role_permissions grant, unless
// another still-active right on the same row grants it too (there is no
// uniqueness constraint stopping a duplicate tag).
func (h *RightsHandler) DeleteRight(c echo.Context) error {
	ctx := c.Request().Context()
	identity := auth.MustIdentity(ctx)

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return errorJSON(c, http.StatusBadRequest, "VALIDATION_ERROR", "invalid id format")
	}
	existing, err := h.rights.FindByID(ctx, id)
	if err != nil || existing.TenantID != identity.TenantID {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Right not found.")
	}
	parent, err := h.viewPerms.FindByID(ctx, existing.RoleViewPermissionID)
	if err != nil || parent.TenantID != identity.TenantID {
		return errorJSON(c, http.StatusNotFound, "NOT_FOUND", "Role view not found.")
	}

	if _, err := h.rights.Delete(ctx, id); err != nil {
		return errorJSON(c, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not delete the right.")
	}
	if err := h.reconcile(ctx, parent.RoleID, parent.Entity); err != nil {
		return fmt.Errorf("auth: reconcile after right delete: %w", err)
	}

	return c.NoContent(http.StatusNoContent)
}

// BackfillAll reconciles role_permissions for EVERY (role,entity) pair that
// currently has an active row in role_view_permission — run once at startup
// (authModule.Migrate) so a role whose Rights were already ticked BEFORE
// this reconciliation existed doesn't need every checkbox re-touched by hand
// to actually start working.
func (h *RightsHandler) BackfillAll(ctx context.Context) error {
	rows, err := h.db.Query(ctx, `SELECT DISTINCT role_id, entity FROM role_view_permission WHERE deleted_at IS NULL`)
	if err != nil {
		return fmt.Errorf("backfill role view permissions: query: %w", err)
	}
	type pair struct {
		roleID uuid.UUID
		entity string
	}
	var pairs []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.roleID, &p.entity); err != nil {
			rows.Close()
			return fmt.Errorf("backfill role view permissions: scan: %w", err)
		}
		pairs = append(pairs, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("backfill role view permissions: %w", err)
	}

	for _, p := range pairs {
		if err := h.reconcile(ctx, p.roleID, p.entity); err != nil {
			return fmt.Errorf("backfill role view permissions: reconcile %s: %w", p.entity, err)
		}
	}
	return nil
}

// reconcile makes role_permissions match exactly what (role,entity)'s
// currently active rights say it should be: entity:entity:read/write/delete
// granted iff that right is tagged, revoked otherwise. Re-derives the full
// "selected" set from the DB rather than applying an incremental delta, so a
// duplicate tag row or a call ordering quirk can never leave a stale grant
// behind — every caller above just needs to call this after its own write,
// naming the (role,entity) pair that write could have affected.
func (h *RightsHandler) reconcile(ctx context.Context, roleID uuid.UUID, entity string) error {
	if entity == "" {
		return nil
	}

	rows, err := h.db.Query(ctx, `
		SELECT DISTINCT art.name
		FROM role_view_permission rvp
		JOIN role_view_permission_right rvpr ON rvpr.role_view_permission_id = rvp.id AND rvpr.deleted_at IS NULL
		JOIN account_role_types art ON art.id = rvpr.account_role_type_id
		WHERE rvp.role_id = $1 AND rvp.entity = $2 AND rvp.deleted_at IS NULL
	`, roleID, entity)
	if err != nil {
		return fmt.Errorf("reconcile: query selected rights: %w", err)
	}
	selected := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return fmt.Errorf("reconcile: scan: %w", err)
		}
		selected[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reconcile: %w", err)
	}

	for _, action := range grantableRights {
		want := selected[action]

		var permID uuid.UUID
		var granted bool
		err := h.db.QueryRow(ctx, `
			SELECT p.id, EXISTS(SELECT 1 FROM role_permissions rp WHERE rp.role_id = $1 AND rp.permission_id = p.id)
			FROM permissions p WHERE p.code = $2 AND p.deleted_at IS NULL
		`, roleID, entity+":"+entity+":"+action).Scan(&permID, &granted)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("reconcile: lookup permission %s:%s:%s: %w", entity, entity, action, err)
		}

		if permID == uuid.Nil {
			if !want {
				continue // never granted before and still shouldn't be — no permission row needed
			}
			created, err := h.perms.UpsertPartial(ctx, auth.Permissions{
				Code:        entity + ":" + entity + ":" + action,
				Description: "Derived from the Rights table (" + entity + ")",
				Module:      entity,
			}, []string{"code"}, "deleted_at IS NULL", "")
			if err != nil {
				return fmt.Errorf("reconcile: create permission %s:%s:%s: %w", entity, entity, action, err)
			}
			permID = created.ID
			granted = false
		}

		switch {
		case want && !granted:
			if _, err := h.db.Exec(ctx, `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, roleID, permID); err != nil {
				return fmt.Errorf("reconcile: grant %s:%s:%s: %w", entity, entity, action, err)
			}
		case !want && granted:
			if _, err := h.db.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, roleID, permID); err != nil {
				return fmt.Errorf("reconcile: revoke %s:%s:%s: %w", entity, entity, action, err)
			}
		}
	}

	h.permRepo.InvalidateCache()
	return nil
}

// toColumnMap mirrors the generic CRUD handler's JSON shape — snake_case db
// column names — using the same public metadata the query builders reflect
// over (Repository.Meta()). See modules/crminheritdemo/handler.go's twin
// helper for the full rationale; this one is generic over T since this file
// overrides routes on two different tables.
func toColumnMap[T model.Entity](repo *orm.Repository[T], entity T) map[string]any {
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
