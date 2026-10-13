// Package searchindex gives every searchable text column of the generic CRUD
// surface a trigram index — automatically, from the ORM registry and
// Postgres's own statistics, so no module ever writes one by hand (ADR-032).
//
// The list endpoint's search[<col>] filter is `col::text ILIKE '%v%'`, which
// no btree can serve: without a gin_trgm_ops index it scans the whole table
// twice per request (count + page). A column gets an index when it is a TEXT
// column of an exposed table (Candidates) AND its statistics say an index
// pays for its write cost (Policy.Eligible).
package searchindex

import (
	"crypto/sha256"
	"encoding/hex"

	"core/orm"
)

// Candidate is a column that could carry a trigram index.
type Candidate struct {
	Table  string
	Column string
}

// ColumnStats is what Postgres's planner statistics say about a column.
type ColumnStats struct {
	TableRows float64 // pg_class.reltuples; -1 = never analyzed
	AvgWidth  int     // pg_stats.avg_width, bytes per non-null value
	NDistinct float64 // pg_stats.n_distinct; negative = fraction of rows
}

// Policy decides from statistics whether a candidate column's index pays for
// itself: every index slows every write of its table, so a column qualifies
// only when a search on it would otherwise be expensive AND useful.
type Policy struct {
	// MinTableRows: below it, a seq scan is ~1 ms and the index is pure cost.
	MinTableRows float64
	// MinAvgWidth: shorter values (codes, empty strings) hold no trigrams worth
	// indexing (avg_width counts a 1-byte header, so 4 ≈ 3 characters).
	MinAvgWidth int
	// MaxAvgWidth: longer free text makes the index huge; full-text search is
	// the right tool there, not trigrams.
	MaxAvgWidth int
	// MinDistinct: fewer distinct values means an enum-like column (status,
	// type) that users filter with in[], not search[].
	MinDistinct float64
}

// DefaultPolicy is the policy the maintainer applies.
var DefaultPolicy = Policy{MinTableRows: 10_000, MinAvgWidth: 4, MaxAvgWidth: 1024, MinDistinct: 100}

// Eligible reports whether a column with these statistics gets an index.
func (p Policy) Eligible(s ColumnStats) bool {
	distinct := s.NDistinct
	if distinct < 0 {
		distinct = -distinct * s.TableRows
	}
	return s.TableRows >= p.MinTableRows &&
		s.AvgWidth >= p.MinAvgWidth && s.AvgWidth <= p.MaxAvgWidth &&
		distinct >= p.MinDistinct
}

// Candidates lists every TEXT column (string, *string, untyped extension and
// WASM columns) of every table on the generic CRUD surface — the columns
// search[] can target. Excluded tables have no search[] to serve.
func Candidates() []Candidate {
	var out []Candidate
	for _, table := range orm.ExposedTableNames() {
		fields, ok := orm.MigrationFieldsForTable(table)
		if !ok {
			continue
		}
		for _, f := range fields {
			if f.SQLType == "TEXT" && !f.IsPK && !f.SoftDel {
				out = append(out, Candidate{Table: table, Column: f.Column})
			}
		}
	}
	return out
}

// maxIdentifier is Postgres's identifier length (NAMEDATALEN-1): a longer
// name is silently truncated by the server, so IndexName keeps it within this.
const maxIdentifier = 63

// IndexName is the deterministic name of c's trigram index:
// trgm_<8 hex of sha256(table.column)>_<table>_<column>, truncated to 63 bytes.
// The hash leads, so it survives truncation, and the joined "table.column"
// input keeps names collision-free: (sale_line, tax) and (sale, line_tax) hash
// differently even though their readable tails are identical. A plain
// idx_<table>_<column> name would not be — CREATE INDEX IF NOT EXISTS would
// then silently skip the second column.
func IndexName(c Candidate) string {
	sum := sha256.Sum256([]byte(c.Table + "." + c.Column))
	name := "trgm_" + hex.EncodeToString(sum[:4]) + "_" + c.Table + "_" + c.Column
	if len(name) > maxIdentifier {
		name = name[:maxIdentifier]
	}
	return name
}
