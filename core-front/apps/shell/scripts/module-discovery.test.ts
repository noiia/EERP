import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backendApiBase,
  backendApiVersion,
  discoverFrom,
  discoverModuleViews,
  findRepoRoot,
  readConfig,
  renderManifest,
  toImportSpecifier,
} from './module-discovery.mjs'

// A temp repo fixture: a config with a module_root, one module that declares a view
// (outside any frontend folder), and a Go-only module that must be skipped. This
// proves the external-folder pipeline end to end before auth or CRM exist.
let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'eerp-discovery-'))
  writeFileSync(join(repo, 'eerp-config.json'), JSON.stringify({ module_root: ['mods'] }))

  const demo = join(repo, 'mods', 'demo')
  mkdirSync(join(demo, 'views'), { recursive: true })
  writeFileSync(
    join(demo, 'module.json'),
    JSON.stringify({ name: 'demo', static_files: { views: ['DemoViews.ts'] } }),
  )
  writeFileSync(join(demo, 'views', 'DemoViews.ts'), 'export default { name: "demo", routes: [] }')

  const goOnly = join(repo, 'mods', 'goonly')
  mkdirSync(goOnly, { recursive: true })
  writeFileSync(join(goOnly, 'module.json'), JSON.stringify({ name: 'goonly', static_files: {} }))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('findRepoRoot', () => {
  it('walks up to the directory holding eerp-config.json', () => {
    expect(findRepoRoot(join(repo, 'mods', 'demo', 'views'))).toBe(repo)
  })

  it('returns null when no config is reachable (e.g. a scoped Docker context)', () => {
    // The filesystem root has no eerp-config.json, so the walk-up exhausts to null.
    expect(findRepoRoot('/')).toBeNull()
  })
})

describe('discoverFrom', () => {
  it('degrades to an empty list when no config is reachable', () => {
    expect(discoverFrom('/')).toEqual([])
  })
})

describe('backendApiBase', () => {
  it('builds host:port and prepends http:// when no scheme', () => {
    expect(backendApiBase({ backend_host: '127.0.0.1', backend_port: 8080 })).toBe('http://127.0.0.1:8080')
  })

  it('keeps an explicit scheme and omits the port when empty', () => {
    expect(backendApiBase({ backend_host: 'https://api.example.com' })).toBe('https://api.example.com')
  })

  it('falls back to public_address, and returns undefined with no host', () => {
    expect(backendApiBase({ public_address: 'core-back', backend_port: 8080 })).toBe('http://core-back:8080')
    expect(backendApiBase({})).toBeUndefined()
  })
})

describe('backendApiVersion', () => {
  it('strips a leading v and returns undefined when unset', () => {
    expect(backendApiVersion({ backend_version: 'v1' })).toBe('1')
    expect(backendApiVersion({ backend_version: '2' })).toBe('2')
    expect(backendApiVersion({})).toBeUndefined()
  })
})

describe('discoverModuleViews', () => {
  it('finds modules declaring static_files.views and skips Go-only modules', () => {
    const discovered = discoverModuleViews(repo, readConfig(repo))
    expect(discovered.map((m) => m.name)).toEqual(['demo'])
    expect(discovered[0].views[0].sourceFile).toBe(
      join(repo, 'mods', 'demo', 'views', 'DemoViews.ts'),
    )
  })

  it('ignores a declared view file that does not exist on disk', () => {
    writeFileSync(
      join(repo, 'mods', 'demo', 'module.json'),
      JSON.stringify({ name: 'demo', static_files: { views: ['Missing.ts'] } }),
    )
    expect(discoverModuleViews(repo, readConfig(repo))).toEqual([])
  })
})

describe('toImportSpecifier', () => {
  it('produces an extensionless relative path from the manifest dir to the source', () => {
    const fromDir = join(repo, 'apps', 'shell', 'src', 'generated')
    const source = join(repo, 'mods', 'demo', 'views', 'DemoViews.ts')
    const spec = toImportSpecifier(fromDir, source)
    expect(spec).toBe('../../../../mods/demo/views/DemoViews')
    expect(spec.startsWith('.')).toBe(true)
  })
})

describe('renderManifest', () => {
  const fromDir = join(repo ?? '', 'apps', 'shell', 'src', 'generated')

  it('emits relative static imports and registrations into the shared registry', () => {
    const manifest = renderManifest(
      discoverModuleViews(repo, readConfig(repo)),
      join(repo, 'apps', 'shell', 'src', 'generated'),
    )
    expect(manifest).toContain("import { moduleRegistry } from '@eerp/core-front/server'")
    expect(manifest).toContain("import m0 from '../../../../mods/demo/views/DemoViews'")
    expect(manifest).toContain('moduleRegistry.register(m0)')
    expect(manifest).toContain('export { moduleRegistry }')
  })

  it('emits an empty (registration-free) manifest when no module has views', () => {
    const manifest = renderManifest([], fromDir)
    expect(manifest).toContain("import { moduleRegistry } from '@eerp/core-front/server'")
    expect(manifest).not.toContain('register(')
  })
})
