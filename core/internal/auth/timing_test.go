package auth_test

import (
	"errors"
	"testing"

	"core/internal/auth"

	"golang.org/x/crypto/bcrypt"
)

// The login handler compares an unknown email against a dummy hash so the
// "user not found" path performs the same bcrypt work as a real check. That only
// closes the timing side-channel if the dummy is a *valid* hash at the same cost —
// the old placeholder was invalid, so bcrypt returned instantly.
func TestLoginTimingMitigation_DummyHashDoesRealWork(t *testing.T) {
	cost, err := bcrypt.Cost(auth.DummyHash)
	if err != nil {
		t.Fatalf("dummy hash is not a valid bcrypt hash: %v", err)
	}
	if cost != bcrypt.DefaultCost {
		t.Errorf("dummy hash cost = %d, want DefaultCost %d (must match stored passwords)", cost, bcrypt.DefaultCost)
	}

	// A comparison must run the full KDF and end in a mismatch — not an
	// invalid-hash error that short-circuits (the previous bug).
	err = bcrypt.CompareHashAndPassword(auth.DummyHash, []byte("any-password"))
	if !errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
		t.Errorf("compare against dummy hash = %v, want ErrMismatchedHashAndPassword", err)
	}
}
