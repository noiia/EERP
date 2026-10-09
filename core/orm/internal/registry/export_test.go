package registry

import "sync"

// Reset clears the global registry state. For testing only.
func Reset() {
	mu.Lock()
	entries = map[string]TableMeta{}
	extensions = map[string][]SchemaField{}
	mu.Unlock()

	apiCfgMu.Lock()
	apiCfg = nil
	apiCfgPath = "api.yaml"
	apiCfgMu.Unlock()
	apiCfgOnce = sync.Once{}
}
