package main

import (
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"0.108.0", "0.170.0", -1}, {"v0.170.0", "0.170.0", 0}, {"dev", "0.999.0", 1},
		{"dev", "dev", 0}, {"0.170.0-pr.3", "0.170.0", -1}, {"0.9.0", "0.10.0", -1},
	} {
		got, err := compareVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("compare(%q,%q) = %d, %v; want %d", c.a, c.b, got, err, c.want)
		}
	}
	if _, err := compareVersions("garbage", "0.1.0"); err == nil {
		t.Error("garbage must error")
	}
}

func TestCheckRange(t *testing.T) {
	for _, c := range []struct{ in, to, errPart string }{
		{"", "0.170.0", ""}, {"0.150.0", "0.170.0", ""}, {"0.170.0", "0.170.0", ""},
		{"0.171.0", "0.170.0", "newer"}, {"0.100.0", "0.170.0", "0.100.0"},
		{"", "0.100.0", "0.100.0"}, {"dev", "0.170.0", "newer"},
	} {
		err := checkRange(c.in, c.to)
		if c.errPart == "" && err != nil || c.errPart != "" && (err == nil || !strings.Contains(err.Error(), c.errPart)) {
			t.Errorf("checkRange(%q,%q) = %v, want %q", c.in, c.to, err, c.errPart)
		}
	}
}
