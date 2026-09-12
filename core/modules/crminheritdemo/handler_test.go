package crminheritdemo

import "testing"

func TestRewordComment(t *testing.T) {
	comment := func(s string) *string { return &s }

	tests := []struct {
		name string
		in   *string
		want *string
	}{
		{"appends the suffix to a supplied comment", comment("Great lead"), comment("Great lead test demo")},
		{"leaves a nil comment (never supplied) alone", nil, nil},
		{"appends after an empty string too", comment(""), comment(" test demo")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := rewordComment(CRM{Comment: tt.in}).Comment

			if (got == nil) != (tt.want == nil) {
				t.Fatalf("Comment = %v, want %v", got, tt.want)
			}
			if got != nil && *got != *tt.want {
				t.Errorf("Comment = %q, want %q", *got, *tt.want)
			}
		})
	}
}
