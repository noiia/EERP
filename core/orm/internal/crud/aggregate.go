package crud

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"core/orm/query"
)

// AggregateRequest is the Graph view's server-side aggregation
// (GET /api/v1/{table}?aggregate=…, docs/adr/ADR-023-graph-server-aggregation.md):
// one aggregate of Value per (X bucket, Group) pair over every row matching
// the list filters — so a chart over 100k rows no longer summarizes only the
// fetched page.
type AggregateRequest struct {
	// Kind is sum, avg, mean (= avg), median or count.
	Kind string
	// Value is a column or an infix formula over columns (+ - * / ( ),
	// number literals) — a Graph calculated field with its calc_ references
	// already expanded by the client. Empty is only valid for count.
	Value string
	// X, when set, is a date/time column bucketed by Bucket (day|week|month).
	X      string
	Bucket string
	// Group, when set, splits rows by that column's text value (series / pie).
	Group string
}

// AggregateRow is one (bucket, group) cell. X and Group are empty when not
// requested; Count is the cell's row count.
type AggregateRow struct {
	X     string  `json:"x,omitempty"`
	Group string  `json:"group,omitempty"`
	Value float64 `json:"value"`
	Count int64   `json:"count"`
}

// AggregateResponse is the envelope for ?aggregate=.
type AggregateResponse struct {
	Groups []AggregateRow `json:"groups"`
}

// ErrBadAggregate is a malformed aggregate request (unknown kind, bucket…).
var ErrBadAggregate = errors.New("invalid aggregate request")

// aggregateCap bounds the returned cells: a chart past this many
// buckets × series isn't readable anyway.
// ponytail: 2000-cell ceiling, paginate if a real chart ever needs more.
const aggregateCap = 2000

var bucketFormat = map[string]struct{ trunc, format string }{
	"day":   {"day", "YYYY-MM-DD"},
	"week":  {"week", "YYYY-MM-DD"}, // Postgres weeks start Monday, like the client's bucketKey
	"month": {"month", "YYYY-MM"},
}

// Aggregate runs req over the rows matching f (same tenant/soft-delete/filter
// guards as FindAll). Every column it touches goes through checkColumn, so
// gated columns behave exactly like nonexistent ones.
func (r *Repository) Aggregate(ctx context.Context, req AggregateRequest, f ListFilter) ([]AggregateRow, error) {
	value, bare, err := r.compileValue(ctx, req.Value)
	if err != nil {
		return nil, err
	}

	var agg string
	switch req.Kind {
	case "sum":
		agg = "COALESCE(SUM(%s), 0)"
	case "avg", "mean":
		agg = "COALESCE(AVG(%s), 0)"
	case "median":
		// A real middle value (the average of the two middles on an even
		// count), like the client's sort-based median — not an approximation.
		agg = "COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY %s), 0)"
	case "count":
		agg = "COUNT(%s)::float8"
	default:
		return nil, fmt.Errorf("%w: aggregate must be sum, avg, mean, median or count", ErrBadAggregate)
	}
	if value == "" {
		if req.Kind != "count" {
			return nil, fmt.Errorf("%w: %s needs a value", ErrBadAggregate, req.Kind)
		}
		value = "*"
	}
	// Count is always the group's row count (a pie slice's size, a stat's
	// "how many records"); Value aggregates value, where COUNT(col) skips
	// NULLs — the client's "skip non-numeric values" rule for a bare column.
	countExpr := "COUNT(*)"

	cols := []string{"'' AS x", "'' AS g", fmt.Sprintf(agg, value) + " AS value", countExpr + " AS count"}
	b := query.Select[struct{}](r.meta.StructMeta)
	var groupBy []string

	if req.X != "" {
		if err := r.checkColumn(ctx, req.X); err != nil {
			return nil, err
		}
		fm, _ := r.meta.FieldByColumn(req.X)
		if !strings.Contains(fm.GoType, "Time") {
			return nil, fmt.Errorf("%w: x must be a date column", ErrBadAggregate)
		}
		bf, ok := bucketFormat[req.Bucket]
		if !ok {
			return nil, fmt.Errorf("%w: bucket must be day, week or month", ErrBadAggregate)
		}
		cols[0] = fmt.Sprintf("to_char(date_trunc('%s', %s AT TIME ZONE 'UTC'), '%s') AS x", bf.trunc, req.X, bf.format)
		b = b.Where(query.NewCondition(req.X + " IS NOT NULL"))
		groupBy = append(groupBy, "1")
	}
	if req.Group != "" {
		if err := r.checkColumn(ctx, req.Group); err != nil {
			return nil, err
		}
		cols[1] = req.Group + "::text AS g"
		// The client skips rows with no group value (null or "") the same way.
		b = b.Where(query.NewCondition("COALESCE(" + req.Group + "::text, '') <> ''"))
		groupBy = append(groupBy, "2")
	}
	// On a chart, a bucket holding only NULLs doesn't exist client-side
	// (xyPoints skips those records) — drop them so it doesn't appear as 0.
	if bare && req.X != "" {
		b = b.Where(query.NewCondition(value + " IS NOT NULL"))
	}

	if r.meta.SoftDelete {
		b = b.Where(query.NewCondition("deleted_at IS NULL"))
	}
	if cond, ok, err := r.tenantCondition(ctx); err != nil {
		return nil, err
	} else if ok {
		b = b.Where(cond)
	}
	pubConds, err := r.publicConditions(ctx)
	if err != nil {
		return nil, err
	}
	for _, cond := range pubConds {
		b = b.Where(cond)
	}
	filters, err := r.filterConditions(ctx, f)
	if err != nil {
		return nil, err
	}
	for _, cond := range filters {
		b = b.Where(cond)
	}

	b = b.Columns(cols...)
	if len(groupBy) > 0 {
		b = b.GroupBy(groupBy...).OrderBy(strings.Join(groupBy, ", "))
	}
	sql, args := b.Limit(aggregateCap).ToSQL()

	var cached []AggregateRow
	key, hit := r.lookup(ctx, sql, args, &cached)
	if hit {
		return cached, nil
	}
	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("crud: aggregate %s: %w", r.meta.TableName, err)
	}
	defer rows.Close()
	out := []AggregateRow{}
	for rows.Next() {
		var row AggregateRow
		if err := rows.Scan(&row.X, &row.Group, &row.Value, &row.Count); err != nil {
			return nil, fmt.Errorf("crud: scan aggregate row: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("crud: aggregate rows: %w", err)
	}
	r.store(ctx, key, out)
	return out, nil
}

var formulaToken = regexp.MustCompile(`\d+\.?\d*|\.\d+|[A-Za-z_]\w*|[-+*/()]`)

// compileValue turns req.Value into a SQL expression. A single known column
// compiles bare (col::float8 — NULLs then drop out of the aggregate, as the
// client skips non-numeric values). Anything else is a formula with the
// client evalFormula's exact semantics: unknown, gated or non-numeric
// identifiers read 0, NULL reads 0, x/0 reads 0, a missing operand reads 0.
// Only validated column names and re-formatted number literals ever reach
// the SQL text.
func (r *Repository) compileValue(ctx context.Context, formula string) (sql string, bare bool, err error) {
	formula = strings.TrimSpace(formula)
	if formula == "" {
		return "", false, nil
	}
	if len(formula) > 500 {
		return "", false, fmt.Errorf("%w: value formula too long", ErrBadAggregate)
	}
	tokens := formulaToken.FindAllString(formula, -1)
	if len(tokens) == 1 && isIdent(tokens[0]) {
		col, ok := r.numericColumn(ctx, tokens[0])
		if !ok {
			return "", false, fmt.Errorf("%w: %s.%s", ErrUnknownColumn, r.meta.TableName, tokens[0])
		}
		return col + "::float8", true, nil
	}

	i := 0
	var expr, primary func() string
	primary = func() string {
		if i >= len(tokens) {
			return "0"
		}
		tok := tokens[i]
		i++
		switch {
		case tok == "(":
			v := expr()
			if i < len(tokens) && tokens[i] == ")" {
				i++
			}
			return "(" + v + ")"
		case tok == "-":
			return "(-" + primary() + ")"
		case tok == "+":
			return primary()
		case tok[0] >= '0' && tok[0] <= '9' || tok[0] == '.':
			n, err := strconv.ParseFloat(tok, 64)
			if err != nil {
				return "0"
			}
			return strconv.FormatFloat(n, 'g', -1, 64) + "::float8"
		case tok == ")" || tok == "*" || tok == "/":
			return "0"
		default:
			if col, ok := r.numericColumn(ctx, tok); ok {
				return "COALESCE(" + col + "::float8, 0)"
			}
			return "0"
		}
	}
	term := func() string {
		v := primary()
		for i < len(tokens) && (tokens[i] == "*" || tokens[i] == "/") {
			op := tokens[i]
			i++
			rhs := primary()
			if op == "*" {
				v = "(" + v + " * " + rhs + ")"
			} else {
				v = "COALESCE(" + v + " / NULLIF(" + rhs + ", 0), 0)"
			}
		}
		return v
	}
	expr = func() string {
		v := term()
		for i < len(tokens) && (tokens[i] == "+" || tokens[i] == "-") {
			op := tokens[i]
			i++
			v = "(" + v + " " + op + " " + term() + ")"
		}
		return v
	}
	return expr(), false, nil
}

func isIdent(tok string) bool {
	c := tok[0]
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// numericColumn resolves an identifier to a numeric column the caller may
// read (checkColumn: exists and not group-gated away).
func (r *Repository) numericColumn(ctx context.Context, name string) (string, bool) {
	if r.checkColumn(ctx, name) != nil {
		return "", false
	}
	fm, _ := r.meta.FieldByColumn(name)
	switch strings.TrimPrefix(fm.GoType, "*") {
	case "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64":
		return name, true
	}
	return "", false
}
