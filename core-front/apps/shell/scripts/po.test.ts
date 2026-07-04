import { describe, expect, it } from 'vitest'
import { parsePo } from './po.mjs'

const SIMPLE = `
# A comment
msgid ""
msgstr ""
"Project-Id-Version: crm 0.0.1\\n"
"Language: fr\\n"

msgid "Name"
msgstr "Nom"

#: views/CrmViews.ts:18
msgid "Email"
msgstr "Courriel"
`

describe('parsePo', () => {
  it('parses msgid/msgstr pairs and skips the header entry', () => {
    const { entries, keys } = parsePo(SIMPLE)
    expect(entries).toEqual({ Name: 'Nom', Email: 'Courriel' })
    expect(keys).toEqual(['Name', 'Email'])
  })

  it('keeps untranslated msgids as keys but not entries (.pot behavior)', () => {
    const { entries, keys } = parsePo('msgid "Status"\nmsgstr ""\n\nmsgid "Company"\nmsgstr ""\n')
    expect(entries).toEqual({})
    expect(keys).toEqual(['Status', 'Company'])
  })

  it('joins multiline strings and unescapes C escapes', () => {
    const po = `
msgid ""
"Hello "
"world"
msgstr "Bonjour\\n"
"le \\"monde\\""
`
    const { entries } = parsePo(po)
    expect(entries['Hello world']).toBe('Bonjour\nle "monde"')
  })

  it('skips entries with msgctxt or plural forms without corrupting neighbors', () => {
    const po = `
msgctxt "menu"
msgid "File"
msgstr "Fichier"

msgid "One"
msgid_plural "Many"
msgstr[0] "Un"
msgstr[1] "Plusieurs"

msgid "Safe"
msgstr "Sûr"
`
    const { entries, keys } = parsePo(po)
    expect(entries).toEqual({ Safe: 'Sûr' })
    expect(keys).toEqual(['Safe'])
  })

  it('ignores obsolete (#~) lines and handles CRLF input', () => {
    const { entries } = parsePo('#~ msgid "Old"\r\nmsgid "New"\r\nmsgstr "Nouveau"\r\n')
    expect(entries).toEqual({ New: 'Nouveau' })
  })
})
