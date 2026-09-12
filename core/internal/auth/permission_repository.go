package auth

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"core/orm"
)

// PermissionRepository checks and fetches effective permissions for role sets.
// Results are cached in-process for 5 minutes to avoid a DB round-trip per request.
type PermissionRepository struct {
	perms *orm.Repository[Permissions]
	db    *orm.DB
	cache sync.Map // key: "roleA,roleB:perm:code" → cachedEntry
}

type cachedEntry struct {
	result bool
	expiry time.Time
}

// NewPermissionRepository constructs a PermissionRepository bound to db.
func NewPermissionRepository(db *orm.DB) *PermissionRepository {
	return &PermissionRepository{
		perms: orm.MustRepo[Permissions](db),
		db:    db,
	}
}

// Has returns true if any role in roles grants the required permission code.
// Checks exact match and wildcards: *:*:*, module:*:action, *:*:action.
func (r *PermissionRepository) Has(ctx context.Context, roles []string, required string) (bool, error) {
	if len(roles) == 0 {
		return false, nil
	}

	cacheKey := strings.Join(roles, ",") + ":" + required
	if entry, ok := r.cache.Load(cacheKey); ok {
		e := entry.(cachedEntry)
		if time.Now().Before(e.expiry) {
			return e.result, nil
		}
		r.cache.Delete(cacheKey)
	}

	codes, err := r.ForRoles(ctx, roles)
	if err != nil {
		return false, fmt.Errorf("permission: has: %w", err)
	}

	result := matchesAny(codes, required)
	r.cache.Store(cacheKey, cachedEntry{result: result, expiry: time.Now().Add(5 * time.Minute)})
	return result, nil
}

// ForRoles returns all permission codes granted by the given role names.
func (r *PermissionRepository) ForRoles(ctx context.Context, roles []string) ([]string, error) {
	if len(roles) == 0 {
		return nil, nil
	}

	placeholders := make([]string, len(roles))
	args := make([]any, len(roles))
	for i, role := range roles {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = role
	}

	rows, err := r.db.Query(ctx, fmt.Sprintf(`
		SELECT DISTINCT p.code
		FROM permissions p
		JOIN role_permissions rp ON rp.permission_id = p.id
		JOIN roles r ON r.id = rp.role_id
		WHERE r.name IN (%s)
		  AND r.deleted_at IS NULL
		  AND p.deleted_at IS NULL
	`, strings.Join(placeholders, ", ")), args...)
	if err != nil {
		return nil, fmt.Errorf("permission: for roles: query: %w", err)
	}
	defer rows.Close()

	var codes []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, fmt.Errorf("permission: for roles: scan: %w", err)
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("permission: for roles: %w", err)
	}
	return codes, nil
}

// InvalidateCache clears the in-process permission cache.
// Call after any write to role_permissions.
func (r *PermissionRepository) InvalidateCache() {
	r.cache.Range(func(k, _ any) bool {
		r.cache.Delete(k)
		return true
	})
}

// matchesAny checks whether required is granted by any code in granted.
// Supports exact match and wildcards: *:*:*, module:*:action, *:*:action.
func matchesAny(granted []string, required string) bool {
	parts := strings.SplitN(required, ":", 3)
	if len(parts) != 3 {
		return false
	}
	mod, res, act := parts[0], parts[1], parts[2]

	for _, g := range granted {
		if g == required {
			return true
		}
		if g == "*:*:*" {
			return true
		}
		gp := strings.SplitN(g, ":", 3)
		if len(gp) != 3 {
			continue
		}
		gm, gr, ga := gp[0], gp[1], gp[2]

		// module:*:action or module:*:*
		if gm == mod && gr == "*" && (ga == act || ga == "*") {
			return true
		}
		// *:*:action
		if gm == "*" && gr == "*" && ga == act {
			return true
		}
		// *:resource:action
		if gm == "*" && gr == res && (ga == act || ga == "*") {
			return true
		}
	}
	return false
}
