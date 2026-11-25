package main

import (
	"fmt"
	"strings"
	"time"
)

// Report is the outcome of an upgrade run.
type Report struct {
	In, Out, Target, Source string
	Diff                    Diff
	S3Objects               int
	Duration                time.Duration
}

func (r Report) String() string {
	src := r.Source
	if src == "" {
		src = "unknown (≥ " + floor + ")"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Upgraded %s (%s) -> %s (%s) in %s, %d S3 objects copied\n",
		r.In, src, r.Out, r.Target, r.Duration.Round(time.Millisecond), r.S3Objects)
	for _, m := range r.Diff.Missing {
		fmt.Fprintf(&b, "ERROR missing: %s\n", m)
	}
	for _, c := range r.Diff.Changed {
		fmt.Fprintf(&b, "ERROR changed: %s\n", c)
	}
	for _, e := range r.Diff.Extra {
		fmt.Fprintf(&b, "warning extra: %s\n", e)
	}
	for _, n := range r.Diff.NotValid {
		fmt.Fprintf(&b, "warning not validated (an existing row violates it): %s\n", n)
	}
	return b.String()
}
