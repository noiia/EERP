package website

import (
	"context"
	"errors"
	"fmt"

	"core/orm"
	"core/orm/access"

	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

// ErrNoSiteTenant means the site tenant is ambiguous: set website_tenant_id.
var ErrNoSiteTenant = errors.New("website: cannot resolve the site tenant — set website_tenant_id")

// ResolveTenant returns the configured tenant, else the single tenant owning
// live users. ponytail: resolved at boot; a dbmanage hot-swap to another
// database keeps the old value until restart.
func ResolveTenant(ctx context.Context, db *orm.DB, configured string) (uuid.UUID, error) {
	if configured != "" {
		id, err := uuid.Parse(configured)
		if err != nil {
			return uuid.Nil, fmt.Errorf("website: website_tenant_id: %w", err)
		}
		return id, nil
	}
	rows, err := db.Query(ctx, `SELECT DISTINCT tenant_id FROM users WHERE deleted_at IS NULL LIMIT 2`)
	if err != nil {
		return uuid.Nil, fmt.Errorf("website: resolve tenant: %w", err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return uuid.Nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, err
	}
	if len(ids) != 1 {
		return uuid.Nil, ErrNoSiteTenant
	}
	return ids[0], nil
}

// TenantMiddleware stamps the site tenant for anonymous requests.
func TenantMiddleware(id uuid.UUID) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.SetRequest(c.Request().WithContext(access.WithTenant(c.Request().Context(), id)))
			return next(c)
		}
	}
}
