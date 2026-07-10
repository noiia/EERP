package module

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// writeFixtureModule writes a minimal module.json under root/name/module.json
// with the given extra fields merged in (name/active always present).
func writeFixtureModule(t *testing.T, root, name string, extra map[string]any) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	record := map[string]any{"name": name, "active": true}
	for k, v := range extra {
		record[k] = v
	}
	data, err := json.MarshalIndent(record, "", "    ")
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	path := filepath.Join(dir, "module.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func TestManagerList(t *testing.T) {
	root := t.TempDir()
	writeFixtureModule(t, root, "crm", nil)
	writeFixtureModule(t, root, "disabled_mod", map[string]any{"active": false})

	mgr := NewManager([]string{root})
	records, err := mgr.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("len(records) = %d, want 2", len(records))
	}

	byName := map[string]map[string]any{}
	for _, r := range records {
		byName[r["name"].(string)] = r
	}

	t.Run("includes inactive modules", func(t *testing.T) {
		disabled, ok := byName["disabled_mod"]
		if !ok {
			t.Fatal("disabled_mod missing from List — inactive modules must still appear")
		}
		if disabled["active"] != false {
			t.Errorf("disabled_mod active = %v, want false", disabled["active"])
		}
	})

	t.Run("id mirrors name", func(t *testing.T) {
		crm, ok := byName["crm"]
		if !ok {
			t.Fatal("crm missing from List")
		}
		if crm["id"] != "crm" {
			t.Errorf("id = %v, want \"crm\"", crm["id"])
		}
	})
}

func TestManagerGet(t *testing.T) {
	root := t.TempDir()
	writeFixtureModule(t, root, "crm", map[string]any{"display_name": "CRM"})
	mgr := NewManager([]string{root})

	t.Run("returns the record by name", func(t *testing.T) {
		record, err := mgr.Get(context.Background(), "crm")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if record["display_name"] != "CRM" {
			t.Errorf("display_name = %v, want CRM", record["display_name"])
		}
	})

	t.Run("unknown module is ErrModuleNotFound", func(t *testing.T) {
		_, err := mgr.Get(context.Background(), "nope")
		if err != ErrModuleNotFound {
			t.Errorf("err = %v, want ErrModuleNotFound", err)
		}
	})
}

func TestManagerPatch(t *testing.T) {
	t.Run("flips active and preserves every unknown key", func(t *testing.T) {
		root := t.TempDir()
		path := writeFixtureModule(t, root, "crm", map[string]any{
			"app_mode":     true,
			"icon":         "🧩",
			"display_name": "CRM",
			"depends":      []any{"contact"},
		})
		mgr := NewManager([]string{root})

		updated, err := mgr.Patch(context.Background(), "crm", map[string]any{"active": false})
		if err != nil {
			t.Fatalf("Patch: %v", err)
		}
		if updated["active"] != false {
			t.Errorf("active = %v, want false", updated["active"])
		}

		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read patched file: %v", err)
		}
		var onDisk map[string]any
		if err := json.Unmarshal(raw, &onDisk); err != nil {
			t.Fatalf("patched file is not valid JSON: %v", err)
		}
		if onDisk["active"] != false {
			t.Errorf("on-disk active = %v, want false", onDisk["active"])
		}
		if onDisk["app_mode"] != true {
			t.Errorf("on-disk app_mode = %v, want true (must survive untouched)", onDisk["app_mode"])
		}
		if onDisk["icon"] != "🧩" {
			t.Errorf("on-disk icon = %v, want 🧩 (must survive untouched)", onDisk["icon"])
		}
		if onDisk["display_name"] != "CRM" {
			t.Errorf("on-disk display_name = %v, want CRM (must survive untouched)", onDisk["display_name"])
		}
	})

	t.Run("app_mode is not a writable field", func(t *testing.T) {
		root := t.TempDir()
		path := writeFixtureModule(t, root, "crm", map[string]any{"app_mode": false})
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		mgr := NewManager([]string{root})

		_, err = mgr.Patch(context.Background(), "crm", map[string]any{"app_mode": true})
		var verr *ValidationError
		if !errors.As(err, &verr) {
			t.Fatalf("err = %v (%T), want *ValidationError", err, err)
		}

		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read file after rejected patch: %v", err)
		}
		if string(after) != string(before) {
			t.Error("file was modified despite the rejected patch")
		}
	})

	t.Run("non-boolean active is rejected", func(t *testing.T) {
		root := t.TempDir()
		writeFixtureModule(t, root, "crm", nil)
		mgr := NewManager([]string{root})

		_, err := mgr.Patch(context.Background(), "crm", map[string]any{"active": "false"})
		var verr *ValidationError
		if !errors.As(err, &verr) {
			t.Fatalf("err = %v (%T), want *ValidationError", err, err)
		}
	})

	t.Run("appstore cannot deactivate itself", func(t *testing.T) {
		root := t.TempDir()
		path := writeFixtureModule(t, root, appstoreModuleName, nil)
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		mgr := NewManager([]string{root})

		_, err = mgr.Patch(context.Background(), appstoreModuleName, map[string]any{"active": false})
		var verr *ValidationError
		if !errors.As(err, &verr) {
			t.Fatalf("err = %v (%T), want *ValidationError", err, err)
		}

		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read file after rejected self-deactivation: %v", err)
		}
		if string(after) != string(before) {
			t.Error("appstore's module.json was modified despite the rejected self-deactivation")
		}
	})

	t.Run("appstore CAN be reactivated (active:true is not self-protected)", func(t *testing.T) {
		root := t.TempDir()
		writeFixtureModule(t, root, appstoreModuleName, map[string]any{"active": false})
		mgr := NewManager([]string{root})

		updated, err := mgr.Patch(context.Background(), appstoreModuleName, map[string]any{"active": true})
		if err != nil {
			t.Fatalf("Patch(active:true) on appstore: %v", err)
		}
		if updated["active"] != true {
			t.Errorf("active = %v, want true", updated["active"])
		}
	})

	t.Run("unknown module is ErrModuleNotFound", func(t *testing.T) {
		root := t.TempDir()
		mgr := NewManager([]string{root})
		_, err := mgr.Patch(context.Background(), "nope", map[string]any{"active": false})
		if err != ErrModuleNotFound {
			t.Errorf("err = %v, want ErrModuleNotFound", err)
		}
	})

	t.Run("concurrent patches don't corrupt the file", func(t *testing.T) {
		root := t.TempDir()
		path := writeFixtureModule(t, root, "crm", nil)
		mgr := NewManager([]string{root})

		const n = 20
		var wg sync.WaitGroup
		wg.Add(n)
		for i := 0; i < n; i++ {
			go func(i int) {
				defer wg.Done()
				_, _ = mgr.Patch(context.Background(), "crm", map[string]any{"active": i%2 == 0})
			}(i)
		}
		wg.Wait()

		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read file after concurrent patches: %v", err)
		}
		var onDisk map[string]any
		if err := json.Unmarshal(raw, &onDisk); err != nil {
			t.Fatalf("file corrupted by concurrent patches: %v (content: %s)", err, raw)
		}
		if _, ok := onDisk["active"].(bool); !ok {
			t.Errorf("active = %v, want a boolean", onDisk["active"])
		}
	})
}
