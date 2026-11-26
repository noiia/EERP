package main

import (
	"fmt"
	"strconv"
	"strings"
)

// floor is the oldest EERP release this tool knows how to upgrade from.
const floor = "0.108.0"

// parsed is a release: X.Y.Z plus whether it is a -pr.N build (ranks just below X.Y.Z).
type parsed struct {
	n   [3]int
	pr  bool
	dev bool
}

func parseVersion(s string) (parsed, error) {
	s = strings.TrimPrefix(s, "v")
	if s == "dev" {
		return parsed{dev: true}, nil
	}
	var p parsed
	core, suffix, hasSuffix := strings.Cut(s, "-")
	if hasSuffix {
		if !strings.HasPrefix(suffix, "pr.") {
			return p, fmt.Errorf("unrecognised version %q", s)
		}
		p.pr = true
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return p, fmt.Errorf("unrecognised version %q", s)
	}
	for i, x := range parts {
		v, err := strconv.Atoi(x)
		if err != nil || v < 0 {
			return p, fmt.Errorf("unrecognised version %q", s)
		}
		p.n[i] = v
	}
	return p, nil
}

// compareVersions orders two releases; "dev" is newer than any release.
func compareVersions(a, b string) (int, error) {
	pa, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	pb, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	switch {
	case pa.dev && pb.dev:
		return 0, nil
	case pa.dev:
		return 1, nil
	case pb.dev:
		return -1, nil
	}
	for i := range pa.n {
		if pa.n[i] != pb.n[i] {
			if pa.n[i] < pb.n[i] {
				return -1, nil
			}
			return 1, nil
		}
	}
	switch {
	case pa.pr == pb.pr:
		return 0, nil
	case pa.pr:
		return -1, nil
	}
	return 1, nil
}

// checkRange refuses a target or input outside floor..target. An empty input
// (a zip with no version.json) passes: its release is unknown.
func checkRange(input, target string) error {
	if c, err := compareVersions(target, floor); err != nil {
		return err
	} else if c < 0 {
		return fmt.Errorf("target version %s is older than the oldest supported release %s", target, floor)
	}
	if input == "" {
		return nil
	}
	if c, err := compareVersions(input, floor); err != nil {
		return err
	} else if c < 0 {
		return fmt.Errorf("input version %s is older than the oldest supported release %s", input, floor)
	}
	if c, err := compareVersions(input, target); err != nil {
		return err
	} else if c > 0 {
		return fmt.Errorf("input version %s is newer than target version %s", input, target)
	}
	return nil
}
