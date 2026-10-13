package searchindex_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"core/internal/searchindex"
	"core/orm"

	"github.com/google/uuid"
)

func TestPolicy_Eligible(t *testing.T) {
	p := searchindex.DefaultPolicy
	ok := searchindex.ColumnStats{TableRows: 100_000, AvgWidth: 14, NDistinct: -0.9}
	for _, tc := range []struct {
		name string
		mod  func(s *searchindex.ColumnStats)
		want bool
	}{
		{"names on a large table", func(*searchindex.ColumnStats) {}, true},
		{"small table: a seq scan is already cheap", func(s *searchindex.ColumnStats) { s.TableRows = 9_999 }, false},
		{"never analyzed (reltuples -1)", func(s *searchindex.ColumnStats) { s.TableRows = -1 }, false},
		{"values too short for trigrams", func(s *searchindex.ColumnStats) { s.AvgWidth = 3 }, false},
		{"long free text", func(s *searchindex.ColumnStats) { s.AvgWidth = 1025 }, false},
		{"enum-like status (absolute n_distinct)", func(s *searchindex.ColumnStats) { s.NDistinct = 3 }, false},
		{"enum-like status (fraction of rows)", func(s *searchindex.ColumnStats) { s.NDistinct = -0.0005 }, false},
		{"100 distinct values is enough", func(s *searchindex.ColumnStats) { s.NDistinct = 100 }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := ok
			tc.mod(&s)
			if got := p.Eligible(s); got != tc.want {
				t.Errorf("Eligible(%+v) = %v, want %v", s, got, tc.want)
			}
		})
	}
}

type probeText struct {
	ID       uuid.UUID      `db:"id,pk"`
	TenantID uuid.UUID      `db:"tenant_id"`
	Name     string         `db:"name"`
	Note     *string        `db:"note"`
	Amount   float64        `db:"amount"`
	Lines    map[string]any `db:"lines"`
	At       time.Time      `db:"at"`
}

type probeHidden struct {
	ID   uuid.UUID `db:"id,pk"`
	Name string    `db:"name"`
}

func TestCandidates_TextColumnsOfExposedTablesOnly(t *testing.T) {
	exposed := fmt.Sprintf("si_probe_text_%d", time.Now().UnixNano())
	hidden := exposed + "_hidden"
	if err := orm.Register[probeText](orm.WithTableName(exposed)); err != nil {
		t.Fatal(err)
	}
	if err := orm.Register[probeHidden](orm.WithTableName(hidden), orm.WithExcluded()); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range searchindex.Candidates() {
		if c.Table == exposed || c.Table == hidden {
			got = append(got, c.Table+"."+c.Column)
		}
	}
	want := []string{exposed + ".name", exposed + ".note"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("candidates = %v, want %v (uuid/number/jsonb/time columns and excluded tables never qualify)", got, want)
	}
}

func TestIndexName(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    searchindex.Candidate
		want string
	}{
		{"short names read naturally", searchindex.Candidate{Table: "contact", Column: "name"}, "idx_contact_name_trgm"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := searchindex.IndexName(tc.c); got != tc.want {
				t.Errorf("IndexName = %q, want %q", got, tc.want)
			}
		})
	}
	t.Run("long names fit Postgres's 63-byte identifier limit and stay distinct", func(t *testing.T) {
		long := strings.Repeat("t", 40)
		a := searchindex.IndexName(searchindex.Candidate{Table: long, Column: strings.Repeat("c", 30) + "_a"})
		b := searchindex.IndexName(searchindex.Candidate{Table: long, Column: strings.Repeat("c", 30) + "_b"})
		if len(a) > 63 || len(b) > 63 || a == b {
			t.Errorf("a=%q (%d) b=%q (%d)", a, len(a), b, len(b))
		}
	})
}
