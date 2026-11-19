import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression: `component={Link}` passes a function to a MUI client component; in a
// Server Component (no 'use client') Next throws at render ("Functions cannot be
// passed directly to Client Components") -> HTTP 500. A file scan is used instead of
// rendering the page because the failure only exists in the RSC serializer, which
// jsdom/vitest rendering never runs.
const root = join(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name === '.next'
      ? []
      : e.isDirectory()
        ? walk(join(dir, e.name))
        : /\.tsx$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
  )
}

describe('component={Link}', () => {
  it('only appears in files marked use client', () => {
    const bad = [...walk(join(root, 'app')), ...walk(join(root, 'src'))]
      .filter((f) => /^[^/\n]*component=\{Link\}/m.test(readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')))
      .filter((f) => !/^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(readFileSync(f, 'utf8')))
    expect(bad).toEqual([])
  })
})
