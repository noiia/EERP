package module

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// Package-level errors and the raw module.json manager behind the App Store's
// management API (docs/roadmaps/app-store.md, Phase 1) — deliberately separate
// from detector.go's typed, snapshot-cached walk: the store needs every
// module.json key, including ones types.Module doesn't know about (app_mode,
// icon, future fields), and a PUT must always patch what is ACTUALLY on disk
// right now, never a cached view of it. So Manager re-walks module_root on
// every call — stateless, no snapshot.

// ErrModuleNotFound is returned by Get/Patch when no module.json's "name" key
// matches the requested id.
var ErrModuleNotFound = errors.New("module not found")

// ValidationError is returned by Patch when changes carries a non-whitelisted
// key, a non-boolean value, or violates the appstore self-protection rule.
// The handler maps it to 400 VALIDATION_ERROR, naming Message.
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

// appstoreModuleName is refused active:false — the store must not brick its
// own UI (docs/roadmaps/app-store.md, Self-protection contract row).
const appstoreModuleName = "appstore"

// writableModuleFields whitelists Patch's accepted keys. ONLY active — every
// other module.json key (app_mode included) is display-only through this API;
// changing it stays a manual file edit (ADR-level decision, app-store.md #6).
var writableModuleFields = map[string]bool{"active": true}

// Manager walks the configured module_root directories for module.json files
// and serves them as raw maps — never round-tripped through types.Module,
// so unknown/future keys always survive a Patch untouched.
type Manager struct {
	moduleRoots []string
	mu          sync.Mutex // serializes writes so concurrent PUTs can't corrupt a file
}

// NewManager wires a Manager over the given module_root paths (already
// resolved to absolute paths by main.go, same as every other config-derived root).
func NewManager(moduleRoots []string) *Manager {
	return &Manager{moduleRoots: moduleRoots}
}

// List returns one raw record per module.json found under the configured
// roots, INCLUDING active:false ones — the whole reason a store exists. The
// App Store module itself is excluded: it manages other apps, it isn't one
// to install/manage — direct lookups by id (Get/Patch) still resolve it.
func (m *Manager) List(_ context.Context) ([]map[string]any, error) {
	var records []map[string]any
	err := m.walk(func(path string, raw map[string]any) error {
		if name, _ := raw["name"].(string); name == appstoreModuleName {
			return nil
		}
		raw["module_dir"] = filepath.Dir(path)
		records = append(records, raw)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return records, nil
}

// Get returns the module.json record whose "name" key equals id, annotated
// with module_dir (the directory the module.json was found in — used by the
// frontend to resolve a view file's real filesystem path). This annotation is
// added here and in List only, never inside readModuleJSON/find directly —
// Patch reuses find() too, and must never write a computed field back into
// module.json.
func (m *Manager) Get(_ context.Context, id string) (map[string]any, error) {
	raw, path, err := m.find(id)
	if err != nil {
		return nil, err
	}
	raw["module_dir"] = filepath.Dir(path)
	return raw, nil
}

// Patch applies changes to id's module.json, restricted to
// writableModuleFields, and returns the updated record. The write is atomic
// (temp file in the same directory + rename) and serialized against every
// other Patch call by mu, so two concurrent requests can't interleave writes
// and corrupt the file.
func (m *Manager) Patch(_ context.Context, id string, changes map[string]any) (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	raw, path, err := m.find(id)
	if err != nil {
		return nil, err
	}

	if err := applyPatch(raw, changes, id); err != nil {
		return nil, err
	}

	if err := writeModuleJSON(path, raw); err != nil {
		return nil, fmt.Errorf("module manager: write %s: %w", path, err)
	}
	return raw, nil
}

// applyPatch mutates raw in place, field by field, failing closed on the
// first disallowed key, wrong-typed value, or self-protection violation —
// nothing is written to raw (or disk) once any single field fails.
func applyPatch(raw, changes map[string]any, moduleName string) error {
	for key, value := range changes {
		if !writableModuleFields[key] {
			return &ValidationError{Message: fmt.Sprintf("%q is not a writable field.", key)}
		}
		b, ok := value.(bool)
		if !ok {
			return &ValidationError{Message: fmt.Sprintf("%q must be a boolean.", key)}
		}
		if key == "active" && !b && moduleName == appstoreModuleName {
			return &ValidationError{Message: "the appstore module cannot deactivate itself."}
		}
		raw[key] = b
	}
	return nil
}

// validateActiveChange checks a PUT body against writableModuleFields before
// the Handler ever touches the runtime gate, extracting the boolean "active"
// value Registry.SetActive needs. Registry.SetActive's own call into
// Manager.Patch re-validates the same rules — this earlier check just lets
// the handler fail closed without flipping anything first.
func validateActiveChange(changes map[string]any) (bool, *ValidationError) {
	for key := range changes {
		if !writableModuleFields[key] {
			return false, &ValidationError{Message: fmt.Sprintf("%q is not a writable field.", key)}
		}
	}
	value, ok := changes["active"]
	if !ok {
		return false, &ValidationError{Message: `"active" is required.`}
	}
	b, ok := value.(bool)
	if !ok {
		return false, &ValidationError{Message: `"active" must be a boolean.`}
	}
	return b, nil
}

// walk visits every module.json under every configured root, decoded raw.
func (m *Manager) walk(visit func(path string, raw map[string]any) error) error {
	for _, root := range m.moduleRoots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || d.Name() != "module.json" {
				return nil
			}
			raw, err := readModuleJSON(path)
			if err != nil {
				return fmt.Errorf("module manager: read %s: %w", path, err)
			}
			return visit(path, raw)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// find locates the module.json whose "name" equals id, returning the raw
// record and its file path. ErrModuleNotFound when no module matches.
func (m *Manager) find(id string) (map[string]any, string, error) {
	var found map[string]any
	var foundPath string
	err := m.walk(func(path string, raw map[string]any) error {
		if found != nil {
			return nil
		}
		if name, _ := raw["name"].(string); name == id {
			found, foundPath = raw, path
		}
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	if found == nil {
		return nil, "", ErrModuleNotFound
	}
	return found, foundPath, nil
}

// readModuleJSON decodes path into a raw map and mirrors "name" onto "id" —
// the frontend's generic list envelope expects every record to carry one
// (docs/roadmaps/app-store.md, Record shape). "display_name" defaults to
// "name" when absent or blank, so every consumer (App Store catalog, Settings
// → Apps, the catch-all page title) always has a human-readable label without
// each of them repeating the same fallback.
func readModuleJSON(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	name, _ := raw["name"].(string)
	if name != "" {
		raw["id"] = name
	}
	if displayName, _ := raw["display_name"].(string); displayName == "" {
		raw["display_name"] = name
	}
	return raw, nil
}

// writeModuleJSON serializes raw back to path atomically: write a same-dir
// temp file, then rename over the original — a crash mid-write leaves the
// original file intact, never a half-written one. encoding/json sorts map
// keys and re-indents at 4 spaces; a resulting diff showing only the changed
// key(s) plus formatting normalization is expected, not a bug (app-store.md
// decision #3).
func writeModuleJSON(path string, raw map[string]any) error {
	data, err := json.MarshalIndent(raw, "", "    ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	data = append(data, '\n')

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
