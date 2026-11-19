// Package formtarget is the security boundary of the website Form block: a
// module registers, in Go, the tables and columns a public form may write, and
// a page layout whose form block maps anything else is refused at save time.
// It is a leaf package (standard library only) so modules can register into it
// and internal/website can import modules without an import cycle.
package formtarget

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

const (
	maxTargets = 10
	maxFields  = 60
)

var addressSuffixes = []string{"_number", "_complement", "_street", "_zip_code", "_city", "_state", "_country"}

var fieldTypes = map[string]bool{
	"text": true, "long": true, "email": true, "phone": true, "number": true,
	"date": true, "checkbox": true, "select": true, "address": true,
}

var (
	mu       sync.RWMutex
	registry = map[string]map[string]bool{}
)

// RegisterFormTarget allows a public form to write the given columns of table.
// Calls for one table accumulate.
func RegisterFormTarget(table string, columns ...string) {
	mu.Lock()
	defer mu.Unlock()
	set := registry[table]
	if set == nil {
		set = map[string]bool{}
		registry[table] = set
	}
	for _, c := range columns {
		set[c] = true
	}
}

// FormTarget returns a copy of the columns registered for table.
func FormTarget(table string) (map[string]bool, bool) {
	mu.RLock()
	defer mu.RUnlock()
	set, ok := registry[table]
	if !ok {
		return nil, false
	}
	out := make(map[string]bool, len(set))
	for c := range set {
		out[c] = true
	}
	return out, true
}

// Target is one registered table with its sorted columns.
type Target struct {
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
}

// Targets lists every registered target, sorted by table then column.
func Targets() []Target {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]Target, 0, len(registry))
	for table, set := range registry {
		t := Target{Table: table, Columns: make([]string, 0, len(set))}
		for c := range set {
			t.Columns = append(t.Columns, c)
		}
		sort.Strings(t.Columns)
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Table < out[j].Table })
	return out
}

// FormConfig is the config of a `form` block (mirrored by the frontend type).
type FormConfig struct {
	Targets       []FormTargetSpec `json:"targets"`
	Fields        []FormField      `json:"fields"`
	LoginRequired bool             `json:"login_required"`
	AllowSignup   bool             `json:"allow_signup"`
	After         FormAfter        `json:"after"`
	AfterLogin    string           `json:"after_login_slug"`
	SubmitLabel   string           `json:"submit_label"`
}

// FormTargetSpec is one table a submission writes. Links[col] = i binds col to
// the id created by target i (which must come earlier); Fixed holds constants.
type FormTargetSpec struct {
	Table string            `json:"table"`
	Links map[string]int    `json:"links"`
	Fixed map[string]string `json:"fixed"`
}

// FormField is one input. For Type "address", Column is the prefix of the 7
// address columns.
type FormField struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Type     string   `json:"type"`
	Column   string   `json:"column"`
	Required bool     `json:"required"`
	Options  []string `json:"options"`
	Target   int      `json:"target"`
	Preset   string   `json:"preset"`
}

// FormAfter is what happens after a successful submit.
type FormAfter struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Slug    string `json:"slug"`
}

var errForm = errors.New("invalid form")

// AddressSuffixes are the 7 column suffixes an "address" field writes, in order.
func AddressSuffixes() []string { return append([]string(nil), addressSuffixes...) }

// FieldColumns returns the columns field f writes: its Column, or the 7
// address columns for an "address" field.
func FieldColumns(f FormField) []string {
	if f.Type != "address" {
		return []string{f.Column}
	}
	out := make([]string, len(addressSuffixes))
	for i, s := range addressSuffixes {
		out[i] = f.Column + s
	}
	return out
}

// ValidateFormConfig refuses any table, column or link the registry does not allow.
func ValidateFormConfig(c FormConfig) error {
	if len(c.Targets) == 0 {
		return fmt.Errorf("%w: at least one target is required", errForm)
	}
	if len(c.Targets) > maxTargets {
		return fmt.Errorf("%w: at most %d targets", errForm, maxTargets)
	}
	if len(c.Fields) > maxFields {
		return fmt.Errorf("%w: at most %d fields", errForm, maxFields)
	}
	cols := make([]map[string]bool, len(c.Targets))
	// used[i] holds the columns target i already writes: each at most once,
	// across links, fixed values and fields (one value per column, no
	// ambiguity about which one wins).
	used := make([]map[string]bool, len(c.Targets))
	claim := func(i int, col string) error {
		if used[i][col] {
			return fmt.Errorf("%w: column %q of target %d is mapped more than once", errForm, col, i)
		}
		used[i][col] = true
		return nil
	}
	for i, t := range c.Targets {
		used[i] = map[string]bool{}
		set, ok := FormTarget(t.Table)
		if !ok {
			return fmt.Errorf("%w: table %q is not a form target", errForm, t.Table)
		}
		cols[i] = set
		for col, from := range t.Links {
			if !set[col] {
				return fmt.Errorf("%w: column %q is not allowed on %q", errForm, col, t.Table)
			}
			if from < 0 || from >= i {
				return fmt.Errorf("%w: link %q of target %d must point to an earlier target", errForm, col, i)
			}
			if err := claim(i, col); err != nil {
				return err
			}
		}
		for col := range t.Fixed {
			if !set[col] {
				return fmt.Errorf("%w: column %q is not allowed on %q", errForm, col, t.Table)
			}
			if err := claim(i, col); err != nil {
				return err
			}
		}
	}
	ids := map[string]bool{}
	for _, f := range c.Fields {
		if f.ID == "" || ids[f.ID] {
			return fmt.Errorf("%w: field id %q is empty or duplicated", errForm, f.ID)
		}
		ids[f.ID] = true
		if !fieldTypes[f.Type] {
			return fmt.Errorf("%w: field %q: unknown type %q", errForm, f.ID, f.Type)
		}
		if f.Target < 0 || f.Target >= len(c.Targets) {
			return fmt.Errorf("%w: field %q: target %d does not exist", errForm, f.ID, f.Target)
		}
		set := cols[f.Target]
		if f.Type == "select" && len(f.Options) == 0 {
			return fmt.Errorf("%w: field %q: a select needs options", errForm, f.ID)
		}
		for _, col := range FieldColumns(f) {
			if !set[col] {
				return fmt.Errorf("%w: field %q: column %q is not allowed on %q", errForm, f.ID, col, c.Targets[f.Target].Table)
			}
			// Ids (foreign keys) come only from links and fixed values — a
			// visitor never types the record another one points at.
			if strings.HasSuffix(col, "_id") {
				return fmt.Errorf("%w: field %q: column %q is an id, set it by a link or a fixed value", errForm, f.ID, col)
			}
			if err := claim(f.Target, col); err != nil {
				return err
			}
		}
	}
	return nil
}
