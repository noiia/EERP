package common

import (
	"core/internal/types"
	"path/filepath"
)

type FileMetaMap map[string]types.FileMeta

// Sort the FileMeta map to reorder the snapshot, based on the dependances in each modules.
func (fmMap FileMetaMap) Reassort() {
	depsList := make(map[string]int, len(fmMap))
	waitList := make([]types.FileMeta, 0, len(fmMap))
	i := 0

	for key, fileMeta := range fmMap {
		if hasAllDeps(fileMeta, depsList) {
			fileMeta.Priority = i
			fmMap[key] = fileMeta
			depsList[filepath.Base(filepath.Dir(fileMeta.Path))] = i
			i++
		} else {
			waitList = append(waitList, fileMeta)
		}
	}

	for len(waitList) > 0 {
		progress := false
		nextWaitList := make([]types.FileMeta, 0, len(waitList))

		for _, fileMeta := range waitList {
			if hasAllDeps(fileMeta, depsList) {
				fileMeta.Priority = i
				fmMap[filepath.Base(filepath.Dir(fileMeta.Path))] = fileMeta
				depsList[filepath.Base(filepath.Dir(fileMeta.Path))] = i
				i++
				progress = true
			} else {
				nextWaitList = append(nextWaitList, fileMeta)
			}
		}

		waitList = nextWaitList
		if !progress {
			break
		}
	}
}

func hasAllDeps(fileMeta types.FileMeta, depsList map[string]int) bool {
	for _, dep := range fileMeta.Dependances {
		if _, ok := depsList[dep]; !ok {
			return false
		}
	}
	return true
}

func (fmMap FileMetaMap) CheckDependencies() (bool, map[string][]string) {
	existingDeps := make(map[string]int, len(fmMap))
	missingDeps := make(map[string][]string, len(fmMap))

	for _, fileMeta := range fmMap {
		existingDeps[filepath.Base(filepath.Dir(fileMeta.Path))] = 0
	}

	for _, fileMeta := range fmMap {
		for _, deps := range fileMeta.Dependances {
			if _, ok := existingDeps[deps]; !ok {
				missingDeps[deps] = append(missingDeps[deps], filepath.Base(filepath.Dir(fileMeta.Path)))
			}
		}
	}

	if len(missingDeps) > 0 {
		return false, missingDeps
	}
	return true, missingDeps
}
