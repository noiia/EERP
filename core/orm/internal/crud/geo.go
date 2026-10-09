package crud

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"core/orm/access"
	"core/orm/geo"
	"core/orm/internal/registry"
	"core/orm/pool/executor"
	"core/orm/query"

	"github.com/google/uuid"
)

// ErrGeoParam is a malformed geo list parameter or a geo param on a column
// of the wrong kind (400). ErrGeoRef is a record reference the caller can't
// use — unknown, excluded or unreadable table, non-shape column, gated column
// (404, so the reason isn't revealed).
var (
	ErrGeoParam = errors.New("crud: invalid geo parameter")
	ErrGeoRef   = errors.New("crud: geo reference not found")
)

// GeoFilter carries the generic list's geo params, keyed by column:
// Near "lon,lat" (order + _distance_m), Within "lon,lat,meters",
// Covers "lon,lat" (shape column), Inside "table:id:shape_col" (point column).
type GeoFilter struct {
	Near, Within, Covers, Inside map[string]string
}

func geoParamErr(col string, err error) error {
	return fmt.Errorf("%w: %s: %v", ErrGeoParam, col, err)
}

// geoColumn checks col like any filter column (whitelist, gating, public
// scope) and that it holds the wanted geo kind.
func (r *Repository) geoColumn(ctx context.Context, col string, want geo.Kind) error {
	if err := r.checkColumn(ctx, col); err != nil {
		return err
	}
	fm, _ := r.meta.FieldByColumn(col)
	if geo.KindOfGoType(fm.GoType) != want {
		return geoParamErr(col, fmt.Errorf("not a %s column", want))
	}
	return nil
}

// geoConditions turns Within/Covers/Inside into WHERE predicates (they also
// narrow ?distinct= and ?aggregate=, like every filter).
func (r *Repository) geoConditions(ctx context.Context, f GeoFilter) ([]query.Condition, error) {
	var conds []query.Condition
	for _, col := range sortedKeys(f.Within) {
		if err := r.geoColumn(ctx, col, geo.KindPoint); err != nil {
			return nil, err
		}
		parts := strings.Split(f.Within[col], ",")
		if len(parts) != 3 {
			return nil, geoParamErr(col, errors.New("within takes <longitude>,<latitude>,<meters>"))
		}
		lon, lat, err := geo.ParseLonLat(parts[0] + "," + parts[1])
		if err != nil {
			return nil, geoParamErr(col, err)
		}
		meters, err := geo.ParseRadius(parts[2])
		if err != nil {
			return nil, geoParamErr(col, err)
		}
		conds = append(conds, query.NewCondition(
			fmt.Sprintf("ST_DWithin(%s, ST_SetSRID(ST_MakePoint($1, $2), %d)::geography, $3)", col, geo.SRID),
			lon, lat, meters))
	}
	for _, col := range sortedKeys(f.Covers) {
		if err := r.geoColumn(ctx, col, geo.KindShape); err != nil {
			return nil, err
		}
		lon, lat, err := geo.ParseLonLat(f.Covers[col])
		if err != nil {
			return nil, geoParamErr(col, err)
		}
		conds = append(conds, query.NewCondition(
			fmt.Sprintf("ST_Covers(%s, ST_SetSRID(ST_MakePoint($1, $2), %d)::geography)", col, geo.SRID),
			lon, lat))
	}
	for _, col := range sortedKeys(f.Inside) {
		cond, err := r.insideCondition(ctx, col, f.Inside[col])
		if err != nil {
			return nil, err
		}
		conds = append(conds, cond)
	}
	return conds, nil
}

// nearClause returns the _distance_m select expression and the ORDER BY for a
// Near param ("" when absent). One near per request: it is the list's order.
func (r *Repository) nearClause(ctx context.Context, f GeoFilter) (selectExpr, orderExpr string, err error) {
	if len(f.Near) == 0 {
		return "", "", nil
	}
	if len(f.Near) > 1 {
		return "", "", fmt.Errorf("%w: only one near[] per request", ErrGeoParam)
	}
	for col, val := range f.Near {
		if err := r.geoColumn(ctx, col, geo.KindPoint); err != nil {
			return "", "", err
		}
		lon, lat, err := geo.ParseLonLat(val)
		if err != nil {
			return "", "", geoParamErr(col, err)
		}
		p := geo.PointSQL(lon, lat)
		return fmt.Sprintf("ST_Distance(%s, %s) AS %s", col, p, DistanceKey),
			fmt.Sprintf("%s <-> %s", col, p), nil
	}
	return "", "", nil
}

var tableActive func(table string) bool

// SetTableActiveCheck wires the live module state so a reference to a table of
// a deactivated module is refused like an unreadable one. nil = all active.
func SetTableActiveCheck(fn func(table string) bool) { tableActive = fn }

// resolveGeoRef turns "table:id:column" into a scalar subquery selecting that
// record's geography value, after the same checks a list read of that table
// would make: registered and on the CRUD surface, readable by the caller
// (access.CanRead), column of the wanted kind (KindNone = any geo) and not
// gated for the caller. Tenant and soft-delete scoping live IN the subquery,
// so a missing or foreign record yields NULL: nothing matches, nothing leaks.
// argOffset is the $n of the subquery's first argument.
func resolveGeoRef(ctx context.Context, ref string, want geo.Kind, argOffset int) (string, []any, error) {
	parts := strings.Split(ref, ":")
	if len(parts) != 3 {
		return "", nil, fmt.Errorf("%w: reference must be <table>:<id>:<column>", ErrGeoParam)
	}
	table, rawID, col := parts[0], parts[1], parts[2]
	id, err := uuid.Parse(rawID)
	if err != nil {
		return "", nil, fmt.Errorf("%w: reference id must be a uuid", ErrGeoParam)
	}
	if _, public := access.PublicScopeFromContext(ctx); public {
		return "", nil, fmt.Errorf("%w: references are not available publicly", ErrGeoParam)
	}
	meta, ok := registry.Get(table)
	if !ok || meta.Excluded || !access.CanRead(ctx, table) || (tableActive != nil && !tableActive(table)) {
		return "", nil, ErrGeoRef
	}
	fm, ok := meta.FieldByColumn(col)
	if !ok {
		return "", nil, ErrGeoRef
	}
	kind := geo.KindOfGoType(fm.GoType)
	if kind == geo.KindNone || (want != geo.KindNone && kind != want) {
		return "", nil, ErrGeoRef
	}
	if len(fm.Groups) > 0 {
		callerGroups, _ := access.GroupsFromContext(ctx)
		if !intersects(fm.Groups, callerGroups) {
			return "", nil, ErrGeoRef
		}
	}
	args := []any{id}
	where := fmt.Sprintf("z.%s = $%d", meta.PKField.Column, argOffset)
	if meta.HasField(tenantColumn) {
		tid, ok := access.TenantFromContext(ctx)
		if !ok || tid == uuid.Nil {
			return "", nil, ErrGeoRef
		}
		args = append(args, tid)
		where += fmt.Sprintf(" AND z.%s = $%d", tenantColumn, argOffset+1)
	}
	if meta.SoftDelete {
		where += " AND z.deleted_at IS NULL"
	}
	return fmt.Sprintf("(SELECT z.%s FROM %s z WHERE %s)", col, meta.TableName, where), args, nil
}

// insideCondition keeps rows whose point col lies in the referenced zone.
func (r *Repository) insideCondition(ctx context.Context, col, ref string) (query.Condition, error) {
	if err := r.geoColumn(ctx, col, geo.KindPoint); err != nil {
		return query.Condition{}, err
	}
	sub, args, err := resolveGeoRef(ctx, ref, geo.KindShape, 1)
	if err != nil {
		return query.Condition{}, err
	}
	return query.NewCondition(fmt.Sprintf("ST_Covers(%s, %s)", sub, col), args...), nil
}

// Distance returns the distance in meters between two referenced geo values
// (point-point, point-zone: 0 inside, else to the boundary; zone-zone), or
// nil when either is empty or its record is missing.
func Distance(ctx context.Context, db executor.Executor, from, to string) (*float64, error) {
	a, aArgs, err := resolveGeoRef(ctx, from, geo.KindNone, 1)
	if err != nil {
		return nil, err
	}
	b, bArgs, err := resolveGeoRef(ctx, to, geo.KindNone, 1+len(aArgs))
	if err != nil {
		return nil, err
	}
	var meters *float64
	if err := db.QueryRow(ctx, fmt.Sprintf("SELECT ST_Distance(%s, %s)", a, b), append(aArgs, bArgs...)...).Scan(&meters); err != nil {
		return nil, fmt.Errorf("crud: distance: %w", err)
	}
	return meters, nil
}
