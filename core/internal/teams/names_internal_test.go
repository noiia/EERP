package teams

import (
	"strings"
	"testing"
)

func TestFreeName(t *testing.T) {
	taken := map[string]bool{"a.pdf": true, "a (2).pdf": true, "docs": true, ".env": true}
	for _, c := range []struct {
		name string
		ext  bool
		want string
	}{
		{"b.pdf", true, "b.pdf"},
		{"A.PDF", true, "A (3).PDF"},
		{"Docs", false, "Docs (2)"},
		{"docs", true, "docs (2)"},
		{".env", true, ".env (2)"},
	} {
		if got := freeName(c.name, taken, c.ext); got != c.want {
			t.Errorf("freeName(%q) = %q, want %q", c.name, got, c.want)
		}
	}
	long := strings.Repeat("x", 196) + ".pdf"
	got := freeName(long, map[string]bool{strings.ToLower(long): true}, true)
	if len([]rune(got)) > 200 || !strings.HasSuffix(got, " (2).pdf") {
		t.Errorf("long name: %d %q", len(got), got)
	}
}
