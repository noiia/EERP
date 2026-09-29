import { expect, it } from 'vitest'
import { pictureUrl, safeHref } from './urls'

it('safeHref allows relative, http(s), mailto only', () => {
  for (const ok of ['/a', '/', 'https://x.io', 'HTTPS://ok.example', 'http://x.io', 'mailto:a@b.c']) expect(safeHref(ok)).toBe(ok)
  for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', 'http:/x', '  /ok', 'javascript:alert(1)', ' javascript:x', 'data:text/html,x', 'a/b', '', undefined]) expect(safeHref(bad)).toBeUndefined()
})

it('pictureUrl encodes each segment', () => {
  expect(pictureUrl('a b', '../x', 'f?')).toBe('/api/v1/public/a%20b/..%2Fx/picture/f%3F')
})
