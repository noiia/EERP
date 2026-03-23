package module

import (
	"core/internal/common"
	"core/internal/types"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// detector rebuilds module snapshots from the provided roots, detects filesystem
// changes, loads module configurations, resolves WASM paths, and returns all detected modules.
func detector(moduleRoots []string) (map[string]types.Module, error) {
	const cachingFolderPath = "./cache/modules"

	modules := make(map[string]types.Module)
	if err := common.MkDirIfNotExists(cachingFolderPath); err != nil {
		return modules, err
	}

	if err := rebuildSnapshots(moduleRoots); err != nil {
		return nil, err
	}

	err := filepath.WalkDir(cachingFolderPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		jsonparse, err := common.DecodeJSON[common.FileMetaMap](path)
		if err != nil {
			return fmt.Errorf("error parsing snapshot file %s: %w", path, err)
		}

		for uuid, data := range jsonparse {
			common.Logger.Info("", zap.String("uuid", uuid), zap.String("path", data.Path))

			moduleConfig, err := common.DecodeJSON[*types.Module](data.Path)
			if err != nil {
				return fmt.Errorf("error parsing module config %s: %w", data.Path, err)
			}

			moduleConfig.Priority = data.Priority
			moduleConfig.Path = data.Path
			if moduleConfig.WasmPath == "" {
				moduleConfig.WasmPath = filepath.Join(filepath.Dir(data.Path), "module.wasm")
				modulesDirectory := filepath.Dir(data.Path)
				if err := common.MkDirIfNotExists(modulesDirectory); err != nil {
					return err
				}

				if err := filepath.WalkDir(modulesDirectory, func(path string, d fs.DirEntry, err error) error {
					if err != nil {
						return err
					}
					if d.IsDir() {
						return nil
					}
					if filepath.Ext(path) == ".wasm" {
						moduleConfig.WasmPath = path
						return filepath.SkipDir
					}
					return nil
				}); err != nil {
					return err
				}
			}

			modules[uuid] = *moduleConfig
		}

		return nil
	})

	return modules, err
}

// Execute rebuildSnapshot for any root in the slice.
//
// Verifying path before rebuilding the snapshot.
func rebuildSnapshots(moduleRoots []string) error {
	for _, moduleRoot := range moduleRoots {
		if _, err := os.Stat(moduleRoot); err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("path doesn't exist: %s", moduleRoot)
			}
			return fmt.Errorf("error accessing path %s: %w", moduleRoot, err)
		}

		if err := rebuildSnapshot(moduleRoot); err != nil {
			return fmt.Errorf("error rebuilding snapshot for %s: %w", moduleRoot, err)
		}
	}
	return nil
}

// Creating caching snapshot with every root's module.
//
// Comparing the last snap with the new one to modifying only the necessary and show the difference.
func rebuildSnapshot(root string) error {
	snapshotFile := "./cache/modules/.fs_snapshot_" + filepath.Base(root) + ".json"

	oldSnap, _ := loadSnapshot(snapshotFile)

	newSnap, err := scanFiles(root)
	if err != nil {
		return err
	}

	if ok, missingDepsMap := newSnap.CheckDependencies(); !ok {
		return fmt.Errorf("modules are calling the following missing dependencies: %v", missingDepsMap)
	}

	newSnap.SetPriorities()

	diff := diffSnapshots(oldSnap, newSnap)

	for _, f := range diff.Added {
		common.Logger.Info("", zap.String("➕", f.Path))
	}

	for _, f := range diff.Removed {
		common.Logger.Info("", zap.String("➖", f.Path))
	}

	return saveSnapshot(snapshotFile, newSnap)
}

// WalkDir in the root to read any of its documents.
//
// Verify if the documents is a file and returning its path, size and modtime
func scanFiles(root string) (common.FileMetaMap, error) {
	files := make(common.FileMetaMap)

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		type Resp struct {
			Name    string   `json:"name"`
			Depends []string `json:"depends"`
			Active  bool     `json:"active"`
		}

		if d.Name() == "module.json" {
			var r Resp
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}

			if err := json.Unmarshal(data, &r); err != nil {
				return err
			}

			uuid := uuid.NewSHA1(uuid.NameSpaceDNS, []byte(r.Name)).String()

			files[uuid] = types.FileMeta{
				Path:        path,
				Size:        info.Size(),
				ModTime:     info.ModTime(),
				Dependences: r.Depends,
				Active:      r.Active,
			}
		}

		return nil
	})

	return files, err
}
