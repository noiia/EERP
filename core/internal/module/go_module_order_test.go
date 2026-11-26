package module_test

import (
	"slices"
	"testing"

	"core/internal/module"
)

type namedMod string

func (n namedMod) Name() string    { return string(n) }
func (n namedMod) Register() error { return nil }

func names(mods []module.GoModule) []string {
	out := make([]string, len(mods))
	for i, m := range mods {
		out[i] = m.Name()
	}
	return out
}

func TestOrderGoModules(t *testing.T) {
	cases := []struct {
		name    string
		reg     []string
		depends map[string][]string
		want    []string
	}{
		{"no depends keeps registration order", []string{"c", "a", "b"}, nil, []string{"c", "a", "b"}},
		{"dependency moves before its dependent", []string{"warehouse", "sale", "auth"},
			map[string][]string{"warehouse": {"auth"}, "sale": {"warehouse"}},
			[]string{"auth", "warehouse", "sale"}},
		{"unknown dependency is ignored", []string{"b", "a"}, map[string][]string{"b": {"missing"}}, []string{"b", "a"}},
		{"cycle keeps every module", []string{"a", "b", "c"},
			map[string][]string{"a": {"b"}, "b": {"a"}}, []string{"c", "a", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mods := make([]module.GoModule, len(tc.reg))
			for i, n := range tc.reg {
				mods[i] = namedMod(n)
			}
			if got := names(module.OrderGoModules(mods, tc.depends)); !slices.Equal(got, tc.want) {
				t.Errorf("order = %v, want %v", got, tc.want)
			}
		})
	}
}
