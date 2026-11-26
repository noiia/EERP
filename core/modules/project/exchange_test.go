package project

import (
	"io"
	"strings"
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

// TestValidRef pins the one rule the decoder, the loader and the diff share for an
// identity a file supplies, and with it the closure of the synthetic half of the
// Key() namespace: nothing that passes can ever be the key Key() builds for a new
// row, which is what stops a file naming itself into another row's identity and
// making that row vanish from the diff.
func TestValidRef(t *testing.T) {
	cases := []struct {
		name string
		ref  string
		want bool
	}{
		{"a task uuid", "11111111-1111-4111-8111-111111111111", true},
		{"a milestone uuid", "milestone:11111111-1111-4111-8111-111111111111", true},
		{"upper case hex is still the same id", "11111111-1111-4111-8111-11111111111A", true},
		{"the nil uuid", "00000000-0000-0000-0000-000000000000", true},

		{"empty", "", false},
		{"a bare number", "7", false},
		{"a word", "not-a-uuid", false},
		{"a uuid missing a dash", "111111111111-4111-8111-111111111111", false},
		{"a uuid one character short", "11111111-1111-4111-8111-11111111111", false},
		{"a non hex digit", "11111111-1111-4111-8111-11111111111g", false},
		{"two ids", "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222", false},

		// The synthetic namespace of Key(), which a file must never be able to
		// reach: each of these would be the key of a row the file added.
		{"the new task prefix", "new:7", false},
		{"the new milestone prefix", "new-milestone:7", false},
		{"the new task prefix alone", "new:", false},
		{"the new task prefix with a uuid", "new:" + "11111111-1111-4111-8111-111111111111", false},
		{"the new milestone prefix with a uuid", "new-milestone:11111111-1111-4111-8111-111111111111", false},
		{"a uuid that starts like the prefix", "newnot-a-uuid", false},

		// The milestone prefix on its own or on something that is not an id.
		{"the milestone prefix alone", "milestone:", false},
		{"the milestone prefix on a number", "milestone:7", false},
		{"the milestone prefix twice", "milestone:milestone:11111111-1111-4111-8111-111111111111", false},
		{"another case of the prefix", "MILESTONE:11111111-1111-4111-8111-111111111111", false},
		{"a prefix EERP does not use", "task:11111111-1111-4111-8111-111111111111", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validRef(tc.ref); got != tc.want {
				t.Errorf("validRef(%q) = %v, want %v", tc.ref, got, tc.want)
			}
			if !tc.want {
				return
			}
			// The property the boundary exists for: an accepted Ref can never be a
			// key Key() builds from a FileID, whatever the FileID is.
			for _, fileID := range []string{"", "7", "1", "milestone:1"} {
				for _, milestone := range []bool{false, true} {
					synthetic := PlanTask{FileID: fileID, Milestone: milestone}.Key()
					if tc.ref == synthetic {
						t.Errorf("validRef accepted %q, which is the Key() of a new row with FileID %q", tc.ref, fileID)
					}
				}
			}
			if strings.HasPrefix(tc.ref, "new:") || strings.HasPrefix(tc.ref, "new-milestone:") {
				t.Errorf("validRef accepted %q, which reaches the new row namespace", tc.ref)
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
func (stubFormat) Carries(Field) bool                          { return true }

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
