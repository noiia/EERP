package editstring_test

import (
	"testing"

	"core/internal/common/editstring"
	"core/internal/common/errornow"
)

func TestClean(t *testing.T) {
	t.Parallel()

	inputString := []string{"NabuK o noDausore", "TOROSACARTAPUS\n\r", "8585 959 448 558 5"}
	outputString := []string{"nabukonodausore", "torosacartapus", "85859594485585"}

	for i := range 3 {
		if value := editstring.LowedNoSpaces(inputString[i]); value != outputString[i] {
			errornow.KillComment(t, "Clean string function error, got"+value+", expected"+outputString[i])
		}
	}

	t.Log("Clean string test : success")
}
