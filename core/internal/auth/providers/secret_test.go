// core/internal/auth/providers/secret_test.go
package providers

import (
	"errors"
	"strings"
	"testing"
)

func TestSecretBox(t *testing.T) {
	b, err := NewSecretBox("master-key-for-tests")
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := b.Seal("s3cret")
	if err != nil || !strings.HasPrefix(sealed, "v1:") || strings.Contains(sealed, "s3cret") {
		t.Fatalf("seal = %q, %v", sealed, err)
	}
	again, _ := b.Seal("s3cret")
	if again == sealed {
		t.Error("two seals of the same secret must differ (random nonce)")
	}
	if plain, err := b.Open(sealed); err != nil || plain != "s3cret" {
		t.Fatalf("open = %q, %v", plain, err)
	}
	other, _ := NewSecretBox("another-master-key")
	if _, err := other.Open(sealed); !errors.Is(err, ErrSecret) {
		t.Errorf("other key: err = %v, want ErrSecret", err)
	}
	for _, bad := range []string{"", "s3cret", "v1:!!", "v1:" + strings.Repeat("A", 8)} {
		if _, err := b.Open(bad); !errors.Is(err, ErrSecret) {
			t.Errorf("Open(%q) err = %v", bad, err)
		}
	}
	if _, err := NewSecretBox(""); err == nil {
		t.Error("empty master key must be refused")
	}
}
