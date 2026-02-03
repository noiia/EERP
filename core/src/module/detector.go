package module

import (
	"core/src/common"
	"core/src/types"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Pour le moment le detecteur fait donc un rebuild de snapshot à chaque fois et pour chaque chemin en entrée.
// En l'état il stocke dans un fichier json tous les chemins et métadonnées des fichiers trouvés dans le répertoire du module.
// Il compare ensuite avec le snapshot précédent pour détecter les ajouts et suppressions de fichiers.
// Il faut donc maintenant implémenter la lecture des configs de chacun des modules détectés et le chargement des modules WASM.
func detector(moduleRoots []string) ([]types.Module, error) {
	const cachingFolderPath = "./cache/modules"

	rebuildSnapshots(moduleRoots)

	var modules []types.Module

	if err := common.MkDirIfNotExists(cachingFolderPath); err != nil {
		return modules, err
	}

	err := filepath.WalkDir(cachingFolderPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		_, err = d.Info()
		if err != nil {
			return err
		}

		_, err = os.ReadFile(path)
		if err != nil {
			return err
		}

		// fileContent := string(fileBytes)

		// modules[path] = types.Module{
		// 	Path:    path,
		// 	Size:    info.Size(),
		// 	ModTime: info.ModTime(),
		// }
		return nil
	})

	return modules, err
}

// Execute rebuildSnapshot for any root in the slice.
//
// Verifying path before rebuilding the snapshot.
func rebuildSnapshots(moduleRoots []string) error {
	for _, moduleRoot := range moduleRoots {
		if notExists, err := common.FileNotExists(moduleRoot); err != nil {
			return err
		} else if !notExists {
			if err := rebuildSnapshot(moduleRoot); err != nil {
				return fmt.Errorf("❌ Error rebuilding snapshot for root:"+moduleRoot, ":", err)
			}
		} else {
			return fmt.Errorf("❌ Error rebuilding snapshot for root:"+moduleRoot, " - Path doesn't exists, please specify an existing folder")
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

	diff := diffSnapshots(oldSnap, newSnap)

	for _, f := range diff.Added {
		fmt.Println("➕", f.Path)
	}

	for _, f := range diff.Removed {
		fmt.Println("➖", f.Path)
	}

	return saveSnapshot(snapshotFile, newSnap)
}

// WalkDir in the root to read any of its documents.
//
// Verify if the documents is a file and returning its path, size and modtime
func scanFiles(root string) (map[string]types.FileMeta, error) {
	files := make(map[string]types.FileMeta)

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

		if d.Name() == "module.json" {
			files[path] = types.FileMeta{
				Path:    path,
				Size:    info.Size(),
				ModTime: info.ModTime(),
			}
		}

		return nil
	})

	return files, err
}
