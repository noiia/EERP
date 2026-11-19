package notify_test

import (
	"os"
	"testing"

	"core/internal/common"

	"go.uber.org/zap"
)

// The service logs failed writes; production initializes the logger at boot.
func TestMain(m *testing.M) {
	if common.Logger == nil {
		common.Logger = zap.NewNop()
	}
	os.Exit(m.Run())
}
