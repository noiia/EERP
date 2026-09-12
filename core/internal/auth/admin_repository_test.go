package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// hashOrLock is the one piece of CreateUser's logic testable without a DB —
// everything else in admin_repository.go goes through *orm.Repository[T],
// which needs a real connection (see make run-back-tests).
func TestHashOrLock(t *testing.T) {
	t.Run("blank password produces a hash nothing can match", func(t *testing.T) {
		hash, err := hashOrLock("")
		if err != nil {
			t.Fatalf("hashOrLock(\"\") error: %v", err)
		}
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("")); err == nil {
			t.Error("empty string matched the locked hash, want a mismatch")
		}
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("password")); err == nil {
			t.Error("a guessable password matched the locked hash, want a mismatch")
		}
	})

	t.Run("a real password hashes to something that verifies", func(t *testing.T) {
		hash, err := hashOrLock("correct horse battery staple")
		if err != nil {
			t.Fatalf("hashOrLock() error: %v", err)
		}
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("correct horse battery staple")); err != nil {
			t.Errorf("the real password did not verify against its own hash: %v", err)
		}
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("wrong")); err == nil {
			t.Error("a wrong password matched the hash, want a mismatch")
		}
	})
}
