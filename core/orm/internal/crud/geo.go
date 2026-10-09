package crud

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"core/orm/geo"
	"core/orm/query"
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

// insideCondition is implemented in Task 5; until then inside[] is refused.
func (r *Repository) insideCondition(_ context.Context, col, _ string) (query.Condition, error) {
	return query.Condition{}, geoParamErr(col, errors.New("inside is not supported yet"))
}
