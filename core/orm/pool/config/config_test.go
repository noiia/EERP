package config_test

import (
	"core/orm/pool/config"
	"strings"
	"testing"
)

func TestConfig_Validate_Valid(t *testing.T) {
	t.Parallel()

	c := config.Config{DSN: "postgres://localhost/erp", MaxConns: 10, MinConns: 2}
	if err := c.Validate(); err != nil {
		t.Errorf("expected no error, got: %v", err)
	}
}

func TestConfig_Validate_EmptyDSN(t *testing.T) {
	t.Parallel()

	c := config.Config{}
	err := c.Validate()
	if err == nil {
		t.Fatal("expected error for empty DSN")
	}
	if !strings.Contains(err.Error(), "DSN") {
		t.Errorf("error should mention DSN, got: %v", err)
	}
}

func TestConfig_Validate_NegativeMaxConns(t *testing.T) {
	t.Parallel()

	c := config.Config{DSN: "postgres://localhost/erp", MaxConns: -1}
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for negative MaxConns")
	}
}

func TestConfig_Validate_MinExceedsMax(t *testing.T) {
	t.Parallel()

	c := config.Config{DSN: "postgres://localhost/erp", MaxConns: 5, MinConns: 10}
	if err := c.Validate(); err == nil {
		t.Fatal("expected error when MinConns > MaxConns")
	}
}

func TestConfig_Validate_ZeroMaxConns_IsValid(t *testing.T) {
	t.Parallel()

	// Zero means "use default" — should pass validation.
	c := config.Config{DSN: "postgres://localhost/erp"}
	if err := c.Validate(); err != nil {
		t.Errorf("zero MaxConns should be valid (defaults apply), got: %v", err)
	}
}
