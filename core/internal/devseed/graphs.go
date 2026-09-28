package devseed

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"

	"core/internal/settings"
	"core/orm"

	"github.com/google/uuid"
)

// GraphThreshold: list-view entities with more rows than this get a seeded
// Graph view (enabled + a tile layout) and calculated fields.
const GraphThreshold = 10000

// calcField is a Graph calculated field (internal/graphfield): simple ones
// are one operation over columns; complex ones nest parentheses, constants
// and other calc_ fields — the client expands calc_ references before the
// server aggregates (ADR-023).
type calcField struct {
	Key, Label, Formula string
}

type tile struct {
	ID     string         `json:"id"`
	X      int            `json:"x"`
	Y      int            `json:"y"`
	W      int            `json:"w"`
	H      int            `json:"h"`
	Type   string         `json:"type"`
	Title  string         `json:"title,omitempty"`
	Config map[string]any `json:"config"`
}

type graphSpec struct {
	fields []calcField
	tiles  []tile
}

// Tile builders — the config keys are graph-widgets.tsx's (xField, yField(s),
// aggregate, bucket, seriesField, mode, groupByField, valueField, field).
func stat(id string, x int, title, field, agg string) tile {
	return tile{ID: id, X: x, Y: 0, W: 6, H: 3, Type: "stat", Title: title, Config: map[string]any{"field": field, "aggregate": agg}}
}

func xy(id string, x, y int, title, xField string, yFields []string, agg, bucket, series string) tile {
	cfg := map[string]any{"xField": xField, "yField": yFields[0], "aggregate": agg, "bucket": bucket}
	if len(yFields) > 1 {
		cfg["yFields"] = yFields
	}
	if series != "" {
		cfg["seriesField"] = series
	}
	return tile{ID: id, X: x, Y: y, W: 12, H: 8, Type: "xy", Title: title, Config: cfg}
}

func bar(id string, x, y int, title, xField, yField, agg, bucket, series, mode string) tile {
	cfg := map[string]any{"xField": xField, "yField": yField, "aggregate": agg, "bucket": bucket, "mode": mode}
	if series != "" {
		cfg["seriesField"] = series
	}
	return tile{ID: id, X: x, Y: y, W: 12, H: 8, Type: "bar", Title: title, Config: cfg}
}

func pie(id string, x, y int, title, group, value string) tile {
	cfg := map[string]any{"groupByField": group}
	if value != "" {
		cfg["valueField"] = value
	}
	return tile{ID: id, X: x, Y: y, W: 8, H: 8, Type: "pie", Title: title, Config: cfg}
}

// documentGraphs is shared by invoices and quotes (same columns).
func documentGraphs(prefix string) graphSpec {
	return graphSpec{
		fields: []calcField{
			{"calc_tax", "Tax collected", "total - subtotal"},
			{"calc_tax_rate", "Effective tax rate (%)", "calc_tax / subtotal * 100"},
			{"calc_net_margin", "Estimated net margin (35% cost, 2% fees)", "subtotal * (1 - 0.35) - (subtotal + calc_tax) * 0.02"},
		},
		tiles: []tile{
			stat(prefix+"-count", 0, "Documents", "id", "count"),
			stat(prefix+"-sum", 6, "Total revenue", "total", "sum"),
			stat(prefix+"-median", 12, "Median document", "total", "median"),
			stat(prefix+"-rate", 18, "Avg effective tax rate (%)", "calc_tax_rate", "avg"),
			xy(prefix+"-monthly", 0, 3, "Monthly totals", "issue_date", []string{"total", "subtotal", "calc_tax"}, "sum", "month", ""),
			bar(prefix+"-status", 12, 3, "Revenue by status", "issue_date", "total", "sum", "month", "status", "stacked"),
			pie(prefix+"-pie", 0, 11, "Share by status", "status", "total"),
			xy(prefix+"-margin", 8, 11, "Weekly avg net margin", "issue_date", []string{"calc_net_margin"}, "avg", "week", ""),
		},
	}
}

var graphSpecs = map[string]graphSpec{
	"invoice": documentGraphs("inv"),
	"quote":   documentGraphs("quo"),
	"contact": {tiles: []tile{
		stat("con-count", 0, "Contacts", "id", "count"),
		pie("con-status", 0, 3, "By status", "status", ""),
		pie("con-company", 8, 3, "By company", "company", ""),
		bar("con-new", 16, 3, "New contacts per month", "created_at", "id", "count", "month", "status", "stacked"),
	}},
	"crm": {
		fields: []calcField{
			{"calc_deal_value", "Deals × satisfaction", "deals * satisfaction"},
			{"calc_health", "Account health index", "((score * 2 + satisfaction) / 3) * (deals + 1) / 10"},
		},
		tiles: []tile{
			stat("crm-count", 0, "Leads", "id", "count"),
			stat("crm-sat", 6, "Avg satisfaction", "satisfaction", "avg"),
			stat("crm-deals", 12, "Median deals", "deals", "median"),
			stat("crm-value", 18, "Total deals × satisfaction", "calc_deal_value", "sum"),
			pie("crm-status", 0, 3, "Pipeline by status", "status", "deals"),
			xy("crm-health", 8, 3, "Monthly avg health by status", "created_at", []string{"calc_health"}, "avg", "month", "status"),
			bar("crm-new", 0, 11, "New leads per month", "created_at", "id", "count", "month", "status", "grouped"),
		},
	},
	"product": {
		fields: []calcField{
			{"calc_price_incl_tax", "Price incl. tax", "unit_price * (1 + tax_rate)"},
			{"calc_tax_per_unit", "Tax per unit", "calc_price_incl_tax - unit_price"},
		},
		tiles: []tile{
			stat("pro-count", 0, "Products", "id", "count"),
			stat("pro-avg", 6, "Avg price", "unit_price", "avg"),
			stat("pro-median", 12, "Median price", "unit_price", "median"),
			stat("pro-tax", 18, "Avg tax per unit", "calc_tax_per_unit", "avg"),
			pie("pro-unit", 0, 3, "By unit", "unit", ""),
			pie("pro-rate", 8, 3, "By tax rate", "tax_rate", ""),
			bar("pro-price", 16, 3, "Avg price incl. tax per month", "created_at", "calc_price_incl_tax", "avg", "month", "unit", "grouped"),
		},
	},
	"product_variant": {
		fields: []calcField{
			{"calc_override_incl_tax", "Override price incl. 20% VAT", "unit_price * 1.2"},
		},
		tiles: []tile{
			stat("var-count", 0, "Variants", "id", "count"),
			stat("var-avg", 6, "Avg override price", "unit_price", "avg"),
			xy("var-monthly", 0, 3, "Variants created per month", "created_at", []string{"id"}, "count", "month", ""),
			xy("var-price", 12, 3, "Avg override price incl. VAT", "created_at", []string{"calc_override_incl_tax"}, "avg", "month", ""),
		},
	},
	"property_management_rent_receipt": {
		fields: []calcField{
			{"calc_rent_per_area", "Rent per m²", "rent_price / floor_area"},
			{"calc_annual_net_per_area", "Annual net rent per m²", "(total - tax_amount) / floor_area * 12"},
		},
		tiles: []tile{
			stat("rent-count", 0, "Receipts", "id", "count"),
			stat("rent-sum", 6, "Rent collected", "total", "sum"),
			stat("rent-area", 12, "Avg rent per m²", "calc_rent_per_area", "avg"),
			stat("rent-median", 18, "Median rent", "rent_price", "median"),
			xy("rent-monthly", 0, 3, "Monthly rent and tax", "generated_at", []string{"total", "subtotal", "tax_amount"}, "sum", "month", ""),
			xy("rent-yield", 12, 3, "Annual net rent per m²", "generated_at", []string{"calc_annual_net_per_area"}, "median", "month", ""),
			pie("rent-props", 0, 11, "Top properties by rent", "property_name", "total"),
		},
	},
}

// seedGraphs gives every list-view entity over GraphThreshold rows a Graph
// view in every company of the tenant (settings are per company): graphs
// enabled in views.<entity>.fields (merged into any existing value) and the
// tile layout in views.<entity>.graph (an existing layout is kept), plus the
// entity's calculated fields (tenant-wide; existing keys kept).
func seedGraphs(ctx context.Context, tx *orm.Tx, tenantID uuid.UUID) ([]Result, error) {
	var results []Result
	for _, entity := range slices.Sorted(maps.Keys(graphSpecs)) {
		spec := graphSpecs[entity]
		var rows int64
		// entity comes from the fixed graphSpecs map, never from a request.
		if err := tx.QueryRow(ctx,
			fmt.Sprintf(`SELECT count(*) FROM %s WHERE tenant_id = $1 AND deleted_at IS NULL`, entity), tenantID).Scan(&rows); err != nil {
			return nil, fmt.Errorf("devseed: count %s: %w", entity, err)
		}
		if rows <= GraphThreshold {
			continue
		}
		layout, err := json.Marshal(map[string]any{"tiles": spec.tiles})
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO app_settings (tenant_id, company_id, key, value)
SELECT $1, c.id, $2, '{"enable_graphs":true}' FROM company c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
ON CONFLICT (tenant_id, company_id, key) DO UPDATE
SET value = (COALESCE(NULLIF(app_settings.value, ''), '{}')::jsonb || '{"enable_graphs":true}')::text, deleted_at = NULL, updated_at = now()`,
			tenantID, settings.ViewFieldsKey(entity)); err != nil {
			return nil, fmt.Errorf("devseed: enable graphs %s: %w", entity, err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO app_settings (tenant_id, company_id, key, value)
SELECT $1, c.id, $2, $3 FROM company c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
ON CONFLICT (tenant_id, company_id, key) DO NOTHING`,
			tenantID, settings.ViewGraphKey(entity), string(layout)); err != nil {
			return nil, fmt.Errorf("devseed: graph layout %s: %w", entity, err)
		}
		for _, f := range spec.fields {
			if _, err := tx.Exec(ctx, `
INSERT INTO graph_field (tenant_id, entity, field_key, label, formula, roles, dated)
VALUES ($1, $2, $3, $4, $5, '', false)
ON CONFLICT (tenant_id, entity, field_key) DO NOTHING`,
				tenantID, entity, f.Key, f.Label, f.Formula); err != nil {
				return nil, fmt.Errorf("devseed: graph field %s.%s: %w", entity, f.Key, err)
			}
		}
		results = append(results, Result{Entity: "graph view: " + entity, Created: int64(len(spec.tiles))})
	}
	return results, nil
}
