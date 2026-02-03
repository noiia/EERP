package module

import (
	"core/src/types"
	"encoding/json"
	"os"
)

func saveSnapshot(path string, data map[string]types.FileMeta) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0644)
}

func loadSnapshot(path string) (map[string]types.FileMeta, error) {
	data := make(map[string]types.FileMeta)

	b, err := os.ReadFile(path)
	if err != nil {
		return data, err
	}

	err = json.Unmarshal(b, &data)
	return data, err
}

func diffSnapshots(oldSnap, newSnap map[string]types.FileMeta) types.Diff {
	diff := types.Diff{}

	for path, meta := range newSnap {
		if _, exists := oldSnap[path]; !exists {
			diff.Added = append(diff.Added, meta)
		}
	}

	for path, meta := range oldSnap {
		if _, exists := newSnap[path]; !exists {
			diff.Removed = append(diff.Removed, meta)
		}
	}

	return diff
}
