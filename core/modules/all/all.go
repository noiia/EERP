//go:build !wasip1

// Package all blank-imports every Go module so their init() functions fire
// and they enlist themselves via module.RegisterGoModule.
// This is the only file that needs to change when a new Go module is added.
package all

import (
	_ "core/modules/contact"
	_ "core/modules/crm"
)
