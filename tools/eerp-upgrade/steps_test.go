package main

import "testing"

func TestStepsFor(t *testing.T) {
	saved := steps
	defer func() { steps = saved }()
	steps = []Step{
		{Release: "0.180.0", Pre: true, Name: "b"},
		{Release: "0.150.0", Pre: true, Name: "a"},
		{Release: "0.160.0", Pre: false, Name: "c"},
	}
	names := func(s []Step) string {
		o := ""
		for _, x := range s {
			o += x.Name
		}
		return o
	}
	if got := names(stepsFor("0.170.0", true)); got != "a" {
		t.Errorf("0.170.0 pre = %q", got)
	}
	if got := names(stepsFor("dev", true)); got != "ab" {
		t.Errorf("dev pre = %q", got)
	}
	if got := names(stepsFor("dev", false)); got != "c" {
		t.Errorf("dev post = %q", got)
	}
}
