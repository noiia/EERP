package project

import (
	"io"
	"testing"
)

func TestPlanTaskKey(t *testing.T) {
	cases := []struct {
		name string
		task PlanTask
		want string
	}{
		{"a matched task keys on its ref", PlanTask{Ref: "u"}, "u"},
		{"a new task keys on its file id", PlanTask{FileID: "7"}, "new:7"},
		{"a new milestone keys on its file id", PlanTask{FileID: "7", Milestone: true}, "new-milestone:7"},
		{"the ref wins over the file id", PlanTask{Ref: "u", FileID: "7"}, "u"},
		{"a matched milestone keeps its prefix", PlanTask{Ref: "milestone:m", FileID: "7", Milestone: true}, "milestone:m"},
		{"an empty task keys as new with no id", PlanTask{}, "new:"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.task.Key(); got != tc.want {
				t.Errorf("Key() = %q, want %q", got, tc.want)
			}
		})
	}
}

// stubFormat stands in for a real adapter: the registry is keyed by Key() and
// the routes look formats up by that key.
type stubFormat struct{ key string }

func (stubFormat) Key() string                                 { return "stub" }
func (stubFormat) Ext() string                                 { return ".stub" }
func (stubFormat) Encode(w io.Writer, p Plan) error            { return nil }
func (stubFormat) Decode(r io.Reader) (Plan, []Warning, error) { return Plan{}, nil, nil }

func TestFormatRegistry(t *testing.T) {
	registerFormat(stubFormat{})

	got, ok := formatByKey("stub")
	if !ok {
		t.Fatal(`formatByKey("stub") = !ok, want the registered format`)
	}
	if got.Key() != "stub" || got.Ext() != ".stub" {
		t.Errorf("registered format = %q/%q, want stub/.stub", got.Key(), got.Ext())
	}
	if _, ok := formatByKey("nope"); ok {
		t.Error(`formatByKey("nope") = ok, want false for an unknown key`)
	}
}
