package settings

import (
	"encoding/json"
	"fmt"
	"sync"
)

// Default Graph layouts a module ships for one of its entities. A module seeds
// its preset into companies with no layout yet; a company that already has one
// (an admin's own, or a dev seed's) keeps it, so the preset also rides the
// graph GET as `defaults`, which the Graph view's edit mode offers as
// "Add default graphs". One copy per entity: the module's own.

var (
	presetsMu    sync.RWMutex
	graphPresets = map[string][]graphTile{}
)

// RegisterGraphPreset records entity's default tiles. tiles is any value that
// marshals to a tile array (a module's own tile structs); it must pass the same
// checks as a saved layout. Registering again replaces the previous preset.
func RegisterGraphPreset(entity string, tiles any) error {
	if !entitySlugPattern.MatchString(entity) {
		return fmt.Errorf("settings: graph preset: bad entity %q", entity)
	}
	raw, err := json.Marshal(tiles)
	if err != nil {
		return fmt.Errorf("settings: graph preset %s: %w", entity, err)
	}
	var parsed []graphTile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return fmt.Errorf("settings: graph preset %s: %w", entity, err)
	}
	if err := validateGraphLayout(graphLayout{Tiles: parsed}); err != nil {
		return fmt.Errorf("settings: graph preset %s: %w", entity, err)
	}
	presetsMu.Lock()
	defer presetsMu.Unlock()
	graphPresets[entity] = parsed
	return nil
}

func graphPreset(entity string) []graphTile {
	presetsMu.RLock()
	defer presetsMu.RUnlock()
	return graphPresets[entity]
}
