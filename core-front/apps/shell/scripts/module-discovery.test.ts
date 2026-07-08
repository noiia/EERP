import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backendApiBase,
  backendApiVersion,
  discoverFrom,
  discoverModuleTranslations,
  discoverModuleViews,
  discoverTranslationsFrom,
  findRepoRoot,
  readConfig,
  renderClientManifest,
  renderManifest,
  renderTranslationsManifest,
  toImportSpecifier,
  translationsForDir,
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
    JSON.stringify({ name: 'demo', app_mode: true, static_files: { views: ['DemoViews.ts'] } }),
  )
  writeFileSync(join(demo, 'views', 'DemoViews.ts'), 'export default { name: "demo", routes: [] }')

  const goOnly = join(repo, 'mods', 'goonly')
  mkdirSync(goOnly, { recursive: true })
  writeFileSync(join(goOnly, 'module.json'), JSON.stringify({ name: 'goonly', static_files: {} }))

  // The Go-only module ships translations anyway — i18n discovery must be independent
  // of static_files.views.
  mkdirSync(join(goOnly, 'i18n'), { recursive: true })
  writeFileSync(
    join(goOnly, 'i18n', 'goonly.pot'),
    'msgid "Name"\nmsgstr ""\n\nmsgid "Status"\nmsgstr ""\n',
  )
  writeFileSync(join(goOnly, 'i18n', 'fr.po'), 'msgid "Name"\nmsgstr "Nom"\n')
  writeFileSync(join(goOnly, 'i18n', 'de.po'), 'msgid "Name"\nmsgstr "Name"\n')
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

  it('skips a deactivated module (active: false), keeping a missing active as active', () => {
    writeFileSync(
      join(repo, 'mods', 'demo', 'module.json'),
      JSON.stringify({
        name: 'demo',
        active: false,
        app_mode: true,
        static_files: { views: ['DemoViews.ts'] },
      }),
    )
    expect(discoverModuleViews(repo, readConfig(repo))).toEqual([])
  })

  it('carries app_mode through, defaulting to false when module.json omits it', () => {
    expect(discoverModuleViews(repo, readConfig(repo))[0].appMode).toBe(true)

    writeFileSync(
      join(repo, 'mods', 'demo', 'module.json'),
      JSON.stringify({ name: 'demo', static_files: { views: ['DemoViews.ts'] } }),
    )
    expect(discoverModuleViews(repo, readConfig(repo))[0].appMode).toBe(false)
  })
})

describe('translationsForDir', () => {
  it('collects .po files (locale = basename) and .pot templates, sorted', () => {
    const bundle = translationsForDir('goonly', join(repo, 'mods', 'goonly'))
    expect(bundle).not.toBeNull()
    expect(bundle!.pos.map((p: { locale: string }) => p.locale)).toEqual(['de', 'fr'])
    expect(bundle!.pots).toEqual([join(repo, 'mods', 'goonly', 'i18n', 'goonly.pot')])
  })

  it('returns null for a directory without an i18n folder', () => {
    expect(translationsForDir('demo', join(repo, 'mods', 'demo'))).toBeNull()
  })
})

describe('discoverModuleTranslations', () => {
  it('finds every module shipping i18n/, regardless of frontend views', () => {
    const discovered = discoverModuleTranslations(repo, readConfig(repo))
    expect(discovered.map((b: { name: string }) => b.name)).toEqual(['goonly'])
  })

  it('skips the translations of a deactivated module (active: false)', () => {
    writeFileSync(
      join(repo, 'mods', 'goonly', 'module.json'),
      JSON.stringify({ name: 'goonly', active: false, static_files: {} }),
    )
    expect(discoverModuleTranslations(repo, readConfig(repo))).toEqual([])
  })

  it('degrades to an empty list when no config is reachable', () => {
    expect(discoverTranslationsFrom('/')).toEqual([])
  })
})

describe('renderTranslationsManifest', () => {
  it('parses catalogs at build time and registers them with the client registry', () => {
    const manifest = renderTranslationsManifest(discoverModuleTranslations(repo, readConfig(repo)))
    expect(manifest).toContain("import { translationRegistry } from '@eerp/core-front'")
    expect(manifest).toContain(
      `translationRegistry.registerTemplate({"module":"goonly","keys":["Name","Status"]})`,
    )
    expect(manifest).toContain(
      `translationRegistry.register({"locale":"fr","module":"goonly","entries":{"Name":"Nom"}})`,
    )
    expect(manifest).toContain('export { translationRegistry }')
  })

  it('emits a registration-free manifest when nothing ships i18n', () => {
    const manifest = renderTranslationsManifest([])
    expect(manifest).toContain("import { translationRegistry } from '@eerp/core-front'")
    expect(manifest).not.toContain('register(')
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
    // The fixture module declares app_mode: true — the registration carries it.
    expect(manifest).toContain('moduleRegistry.register(m0, { appMode: true })')
    expect(manifest).toContain('export { moduleRegistry }')
  })

  it('registers a module without app_mode plainly (routes only, no menu tile)', () => {
    writeFileSync(
      join(repo, 'mods', 'demo', 'module.json'),
      JSON.stringify({ name: 'demo', static_files: { views: ['DemoViews.ts'] } }),
    )
    const manifest = renderManifest(discoverModuleViews(repo, readConfig(repo)), fromDir)
    expect(manifest).toContain('moduleRegistry.register(m0)')
    expect(manifest).not.toContain('appMode')
  })

  it('emits an empty (registration-free) manifest when no module has views', () => {
    const manifest = renderManifest([], fromDir)
    expect(manifest).toContain("import { moduleRegistry } from '@eerp/core-front/server'")
    expect(manifest).not.toContain('register(')
  })
})

describe('renderClientManifest', () => {
  it('mirrors the server manifest through the CLIENT barrel — never the server one', () => {
    // fromDir must resolve inside the test: `repo` is (re)created per test by beforeEach.
    const fromDir = join(repo, 'apps', 'shell', 'src', 'generated')
    const manifest = renderClientManifest(discoverModuleViews(repo, readConfig(repo)), fromDir)
    // Same views, evaluated in the browser bundle: import-time behavior
    // registrations run, and each FrontModule registers with the CLIENT
    // moduleRegistry (the create wizard resolves form descriptors from it).
    expect(manifest).toContain("import { moduleRegistry } from '@eerp/core-front'")
    expect(manifest).toContain("import m0 from '../../../../mods/demo/views/DemoViews'")
    expect(manifest).toContain('moduleRegistry.register(m0, { appMode: true })')
    expect(manifest).not.toContain('@eerp/core-front/server')
  })

  it('emits a registration-free manifest when no module has views', () => {
    const manifest = renderClientManifest([], join(repo, 'apps', 'shell', 'src', 'generated'))
    expect(manifest).toContain("import { moduleRegistry } from '@eerp/core-front'")
    expect(manifest).not.toContain('register(')
  })
})
