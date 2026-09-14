package cron

import (
	"testing"

	"core/internal/cron"
)

// TestResolveActionCode exercises the one pure decision this override adds
// (everything else is thin ORM/HTTP wiring, covered by make run-back-tests'
// integration pass against a real DB — see core/CLAUDE.md's testing note).
func TestResolveActionCode(t *testing.T) {
	if got := resolveActionCode(""); got != "" {
		t.Errorf("resolveActionCode(\"\") = %q, want empty", got)
	}

	if got := resolveActionCode("does.not.exist"); got == "" {
		t.Errorf("resolveActionCode(unknown) should explain the missing action, got empty string")
	}

	cron.Register(cron.Action{ID: "demo.action", Source: "// demo source\n"})
	if got := resolveActionCode("demo.action"); got != "// demo source\n" {
		t.Errorf("resolveActionCode(registered) = %q, want the registered Source", got)
	}
}
