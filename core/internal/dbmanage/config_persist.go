package dbmanage

import (
	"encoding/json"
	"fmt"
	"os"
)

// persistDBName rewrites just the "db_name" key in the on-disk config JSON,
// leaving every other key untouched — same round-trip-unknown-keys-safely
// approach and same temp-file-then-rename atomic write internal/module's
// module.json PUT already uses (core/internal/module/manager.go's
// writeModuleJSON), applied here to eerp-config.json instead. Reading into a
// raw map rather than *types.Config is deliberate: this must never risk
// dropping or reformatting a config field it doesn't know about.
func persistDBName(path, dbName string) error {
	if path == "" {
		return fmt.Errorf("dbmanage: no config file path configured")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	doc["db_name"] = dbName

	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	data = append(data, '\n')

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename config: %w", err)
	}
	return nil
}
