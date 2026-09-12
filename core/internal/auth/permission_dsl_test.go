package auth_test

import (
	"testing"

	"core/internal/auth"
)

func TestMatchesAny(t *testing.T) {
	for _, tc := range permissionMatchCases {
		got := auth.MatchesAny(tc.granted, tc.required)
		if got != tc.want {
			t.Errorf("MatchesAny(%v, %q) = %v, want %v", tc.granted, tc.required, got, tc.want)
		}
	}
}
