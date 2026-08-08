// Command eerp-init-module scaffolds a new EERP business module: the Go
// backend package (module.json + module.go + module_test.go) and the
// frontend views package (package.json, tsconfig.json, vitest.config.ts,
// views/), following the shape of core/modules/contact and
// core/modules/crminheritdemo.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/template"
)

var nameRE = regexp.MustCompile(`^[a-z][a-z0-9]*$`)

type data struct {
	Name   string // "expense"
	Pascal string // "Expense"
	Type   string // "go" or "wasm"
}

func main() {
	path := flag.String("p", "", "path where the new module should be created, e.g. core/modules/expense")
	modType := flag.String("t", "", "module type: go or wasm")
	flag.Parse()

	if err := run(*path, *modType); err != nil {
		fmt.Fprintln(os.Stderr, "eerp-init-module:", err)
		os.Exit(1)
	}
}

func run(path, modType string) error {
	if path == "" {
		return fmt.Errorf("-p <path> is required")
	}
	if modType != "go" && modType != "wasm" {
		return fmt.Errorf("-t must be \"go\" or \"wasm\", got %q", modType)
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	name := filepath.Base(absPath)
	if !nameRE.MatchString(name) {
		return fmt.Errorf("module name %q (from path %q) must match %s — it becomes a Go package name, an npm package name, and a DB table name", name, path, nameRE.String())
	}
	if _, err := os.Stat(absPath); err == nil {
		return fmt.Errorf("%s already exists", absPath)
	}

	d := data{Name: name, Pascal: strings.ToUpper(name[:1]) + name[1:], Type: modType}

	if err := writeFiles(absPath, d); err != nil {
		return err
	}
	fmt.Printf("created module %q at %s\n", name, absPath)

	root := findRepoRoot(absPath)
	if root == "" {
		fmt.Println("could not locate repo root (no eerp-config.json above the target path) — skipping all.go wiring and pnpm install")
		return nil
	}

	coreModulesDir := filepath.Join(root, "core", "modules")
	inCoreModules := filepath.Dir(absPath) == coreModulesDir

	if modType == "go" {
		if inCoreModules {
			if err := wireGoModule(filepath.Join(coreModulesDir, "all", "all.go"), name); err != nil {
				fmt.Fprintln(os.Stderr, "warning: could not wire module into core/modules/all/all.go:", err)
			} else {
				fmt.Println("registered import in core/modules/all/all.go")
			}
		} else {
			fmt.Println("path is outside core/modules — skipping all.go wiring; wire the module's Register() by hand")
		}
	}

	if inCoreModules {
		fmt.Println("running pnpm install in core-front (links the new module via the ../core/modules/* workspace glob)...")
		cmd := exec.Command("pnpm", "install")
		cmd.Dir = filepath.Join(root, "core-front")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			fmt.Fprintln(os.Stderr, "warning: pnpm install failed:", err)
		}
	} else {
		fmt.Println("path is outside core/modules — not part of the core-front pnpm workspace, skipping pnpm install")
	}

	return nil
}

// findRepoRoot walks up from start looking for eerp-config.json.
func findRepoRoot(start string) string {
	dir := start
	for {
		if _, err := os.Stat(filepath.Join(dir, "eerp-config.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

type file struct {
	relPath string
	tmpl    string
}

var files = []file{
	{"module.json", moduleJSONTmpl},
	{"module.go", moduleGoTmpl},
	{"module_test.go", moduleTestGoTmpl},
	{"package.json", packageJSONTmpl},
	{"tsconfig.json", tsconfigTmpl},
	{"vitest.config.ts", vitestConfigTmpl},
	{filepath.Join("views", "{{.Pascal}}Views.ts"), viewsTmpl},
	{filepath.Join("views", "{{.Pascal}}Views.test.ts"), viewsTestTmpl},
	{filepath.Join("i18n", "{{.Name}}.pot"), potTmpl},
}

func writeFiles(root string, d data) error {
	for _, f := range files {
		relPath, err := renderString(f.relPath, d)
		if err != nil {
			return err
		}
		full := filepath.Join(root, relPath)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		content, err := renderString(f.tmpl, d)
		if err != nil {
			return fmt.Errorf("render %s: %w", relPath, err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func renderString(tmpl string, d data) (string, error) {
	t, err := template.New("").Parse(tmpl)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	if err := t.Execute(&sb, d); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// wireGoModule inserts `_ "core/modules/<name>"` into core/modules/all/all.go's
// import block, in alphabetical order — the file's own comment says it's "the
// only file that needs to change when a new Go module is added".
func wireGoModule(allGoPath, name string) error {
	f, err := os.Open(allGoPath)
	if err != nil {
		return err
	}
	newImport := fmt.Sprintf("\t_ %q", "core/modules/"+name)

	var before, imports, after []string
	section := 0 // 0=before import(, 1=inside, 2=after )
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		switch section {
		case 0:
			before = append(before, line)
			if strings.TrimSpace(line) == "import (" {
				section = 1
			}
		case 1:
			if strings.TrimSpace(line) == ")" {
				after = append(after, line)
				section = 2
				continue
			}
			if strings.TrimSpace(line) == newImport[1:] || line == newImport {
				f.Close()
				return fmt.Errorf("module %q is already imported", name)
			}
			imports = append(imports, line)
		case 2:
			after = append(after, line)
		}
	}
	f.Close()
	if err := scanner.Err(); err != nil {
		return err
	}
	if section != 2 {
		return fmt.Errorf("could not find a well-formed import block in %s", allGoPath)
	}

	imports = append(imports, newImport)
	sort.Strings(imports)

	var out strings.Builder
	for _, l := range before {
		out.WriteString(l + "\n")
	}
	for _, l := range imports {
		out.WriteString(l + "\n")
	}
	for i, l := range after {
		out.WriteString(l)
		if i != len(after)-1 {
			out.WriteString("\n")
		}
	}
	return os.WriteFile(allGoPath, []byte(out.String()), 0o644)
}

const moduleJSONTmpl = `{
    "active": true,
    "type": "{{.Type}}",
    "name": "{{.Name}}",
    "display_name": "{{.Pascal}}",
    "version": "0.0.1",
    "author": "",
    "description": "",
    "depends": [],
    "static_files": {
        "views": [
            "{{.Pascal}}Views.ts"
        ]
    },
    "is_service": false,
    "auto_install": false
}
`

const moduleGoTmpl = `package {{.Name}}

import (
	"core/internal/module"
	"core/orm"
	"core/orm/model"

	"github.com/google/uuid"
)

func init() {
	module.RegisterGoModule(&{{.Name}}Module{})
}

// {{.Pascal}} is the {{.Name}} module's base entity — a starting point, rename
// and extend its fields for the real domain model.
type {{.Pascal}} struct {
	model.BaseModel
	TenantID uuid.UUID ` + "`db:\"tenant_id\"`" + `
	Name     string    ` + "`db:\"name\"`" + `
}

type {{.Name}}Module struct{}

func (m *{{.Name}}Module) Name() string { return "{{.Name}}" }

func (m *{{.Name}}Module) Register() error {
	return orm.Register[{{.Pascal}}]()
}
`

const moduleTestGoTmpl = `package {{.Name}}

import (
	"testing"

	"core/orm"
)

// Every ERP table must carry a tenant_id column so the generic CRUD layer
// isolates rows per tenant (see security-breach-rm.md item 1/1a).
func Test{{.Pascal}}_IsTenantScoped(t *testing.T) {
	if err := (&{{.Name}}Module{}).Register(); err != nil {
		t.Fatalf("register: %v", err)
	}

	fields, ok := orm.MigrationFieldsForTable("{{.Name}}")
	if !ok {
		t.Fatal("{{.Name}} table not registered")
	}
	for _, f := range fields {
		if f.Column == "tenant_id" {
			return
		}
	}
	t.Error("{{.Name}} is missing tenant_id — tenant isolation would not apply")
}
`

const packageJSONTmpl = `{
  "name": "@eerp/{{.Name}}",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "description": "{{.Pascal}} module frontend views (descriptors only) for the EERP engine.",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@eerp/core-front": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^6",
    "vitest": "^4"
  }
}
`

const tsconfigTmpl = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "types": ["vitest/globals"]
  },
  "include": ["views"]
}
`

const vitestConfigTmpl = `import { defineConfig } from 'vitest/config'

// @eerp/core-front's runtime barrel reaches MUI, whose ESM does a directory
// import of react-transition-group that Node's ESM loader rejects; inlining
// routes it through Vite's resolver instead (same stance as every other
// module's vitest.config.ts).
export default defineConfig({
  test: {
    server: {
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
  },
})
`

const viewsTmpl = `import type { FrontModule, ViewDescriptor } from '@eerp/core-front'

// {{.Name}} frontend — DESCRIPTORS ONLY. The engine derives the server loader, the
// Zustand store, and the renderer from these; this module ships no controllers
// or renderers.
//
// ` + "`entity`" + ` maps 1:1 to the Go route prefix registered by module.go's orm.Register —
// snake_case "{{.Name}}" (GET /api/v1/{{.Name}}). Field names must match the DB column
// names the handler returns, and permission strings mirror the route:
// {{.Name}}:{{.Name}}:<action>.

export interface {{.Pascal}} {
  id: string
  tenant_id: string
  name: string
}

const fields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
]

const dashboardView: ViewDescriptor = {
  entity: '{{.Name}}',
  viewType: 'dashboard',
  fields,
  permissions: ['{{.Name}}:{{.Name}}:read'],
}

const listView: ViewDescriptor = {
  entity: '{{.Name}}',
  viewType: 'tree',
  fields,
  formPath: '/{{.Name}}/:id',
  createPermission: '{{.Name}}:{{.Name}}:write',
  permissions: ['{{.Name}}:{{.Name}}:read'],
}

const formView: ViewDescriptor = {
  entity: '{{.Name}}',
  viewType: 'form',
  fields,
  permissions: ['{{.Name}}:{{.Name}}:read'],
}

const {{.Name}}: FrontModule = {
  name: '{{.Name}}',
  routes: [
    { path: '/{{.Name}}', descriptor: dashboardView },
    { path: '/{{.Name}}/list', descriptor: listView },
    { path: '/{{.Name}}/:id', descriptor: formView },
  ],
}

export default {{.Name}}
`

const viewsTestTmpl = `import { describe, expect, it } from 'vitest'
import mod from './{{.Pascal}}Views'

describe('{{.Name}} FrontModule', () => {
  it('registers the expected routes', () => {
    expect(mod.name).toBe('{{.Name}}')
    expect(mod.routes.map((r) => r.path)).toEqual(['/{{.Name}}', '/{{.Name}}/list', '/{{.Name}}/:id'])
  })
})
`

const potTmpl = `# {{.Pascal}} module — translation template. Copy to <locale>.po per language.
msgid ""
msgstr ""
"Project-Id-Version: {{.Name}} 0.0.1\n"
"Content-Type: text/plain; charset=UTF-8\n"

msgid "Name"
msgstr ""
`
