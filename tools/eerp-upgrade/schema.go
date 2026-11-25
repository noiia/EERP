package main

import (
	"context"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

// Schema is a normalized catalog snapshot of the public schema: key -> definition.
// Definitions carry no ordinal positions, so two databases compare order-insensitively.
type Schema map[string]string

// Diff is one-directional: Extra objects in got are tolerated (see Failed).
type Diff struct{ Missing, Changed, Extra []string }

// Failed reports drift that matters: something absent or different. Extras are fine
// (an old database may carry search indexes or columns a fresh one lacks).
func (d Diff) Failed() bool { return len(d.Missing)+len(d.Changed) > 0 }

func diffSchemas(ref, got Schema) Diff {
	var d Diff
	for k, want := range ref {
		g, ok := got[k]
		switch {
		case !ok:
			d.Missing = append(d.Missing, k)
		case g != want:
			d.Changed = append(d.Changed, fmt.Sprintf("%s: want %s got %s", k, want, g))
		}
	}
	for k := range got {
		if _, ok := ref[k]; !ok {
			d.Extra = append(d.Extra, k)
		}
	}
	sort.Strings(d.Missing)
	sort.Strings(d.Changed)
	sort.Strings(d.Extra)
	return d
}

// Tables and functions owned by an extension (PostGIS' spatial_ref_sys, st_*) are
// skipped, along with everything hanging off such tables.
const schemaSQL = `
WITH t AS (
  SELECT c.oid, c.relname FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                    AND d.objid = c.oid AND d.deptype = 'e')
)
SELECT 'column:' || t.relname || '.' || a.attname,
       format_type(a.atttypid, a.atttypmod) || '|' || CASE WHEN a.attnotnull THEN 'not null' ELSE 'null' END
       || '|' || COALESCE(CASE WHEN a.attgenerated = '' THEN pg_get_expr(ad.adbin, ad.adrelid) END, '')
       || '|' || COALESCE(CASE WHEN a.attgenerated <> '' THEN pg_get_expr(ad.adbin, ad.adrelid) END, '')
FROM t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
UNION ALL
SELECT 'index:' || i.indexname, i.indexdef FROM pg_indexes i JOIN t ON t.relname = i.tablename
WHERE i.schemaname = 'public'
UNION ALL
SELECT 'constraint:' || t.relname || '.' || co.conname, pg_get_constraintdef(co.oid)
FROM t JOIN pg_constraint co ON co.conrelid = t.oid
UNION ALL
SELECT 'trigger:' || t.relname || '.' || tg.tgname, pg_get_triggerdef(tg.oid)
FROM t JOIN pg_trigger tg ON tg.tgrelid = t.oid AND NOT tg.tgisinternal
UNION ALL
SELECT 'function:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f','p')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                  AND d.objid = p.oid AND d.deptype = 'e')`

func loadSchema(ctx context.Context, conn *pgx.Conn) (Schema, error) {
	rows, err := conn.Query(ctx, schemaSQL)
	if err != nil {
		return nil, fmt.Errorf("load schema: %w", err)
	}
	defer rows.Close()
	s := Schema{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		s[k] = v
	}
	return s, rows.Err()
}
