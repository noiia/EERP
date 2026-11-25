package main

import (
	"context"
	"errors"

	"core/internal/types"
)

// run is the upgrade pipeline (Task 4).
func run(ctx context.Context, cfg *types.Config, a args) (Report, error) {
	return Report{}, errors.New("upgrade pipeline not implemented yet")
}
