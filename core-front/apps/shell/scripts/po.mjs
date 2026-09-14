// Minimal gettext .po/.pot parser for the build-time i18n codegen. Parses exactly
// what the translation pipeline needs — msgid/msgstr pairs with multiline strings and
// C-style escapes — and deliberately nothing more (no plurals, no msgctxt: entries
// carrying them are skipped whole, so a fancier .po degrades to fewer strings, never
// to corrupt ones). Runs only at build time; the browser ships parsed JSON.

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }

function unquote(line) {
  // '"..."' -> unescaped inner text; null when the line isn't a string literal.
  const match = /^"(.*)"$/.exec(line)
  if (!match) return null
  return match[1].replace(/\\(.)/g, (_, ch) => ESCAPES[ch] ?? ch)
}

/**
 * Parse .po/.pot content into { entries, keys }:
 *  - entries: msgid -> msgstr for every translated pair (empty msgstrs dropped — a
 *    .pot therefore yields {} here)
 *  - keys: every non-empty msgid, translated or not (what a .pot declares)
 * The gettext header (msgid "") is skipped; so are comments and obsolete (#~) lines.
 * Entries with msgid_plural or msgctxt are skipped entirely (unsupported).
 */
export function parsePo(content) {
  const entries = {}
  const keys = []

  // One entry = consecutive msgid/msgstr (+ continuation strings), separated by
  // blank lines or the next msgid. Track the field being continued.
  let msgid = null
  let msgstr = null
  let unsupported = false
  // msgctxt appears BEFORE its msgid, so the flag must survive the flush that the
  // following msgid triggers — staged here, consumed when that msgid starts.
  let nextUnsupported = false
  let field = null // 'msgid' | 'msgstr' | null

  const flush = () => {
    if (msgid !== null && msgid !== '' && !unsupported) {
      keys.push(msgid)
      if (msgstr) entries[msgid] = msgstr
    }
    msgid = null
    msgstr = null
    unsupported = false
    field = null
  }

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    if (line.startsWith('msgctxt')) {
      nextUnsupported = true
      field = null
    } else if (line.startsWith('msgid_plural')) {
      unsupported = true
      field = null
    } else if (line.startsWith('msgid ')) {
      flush()
      msgid = unquote(line.slice('msgid '.length).trim()) ?? ''
      unsupported = nextUnsupported
      nextUnsupported = false
      field = 'msgid'
    } else if (line.startsWith('msgstr')) {
      // Covers plain `msgstr "..."`; indexed plural forms `msgstr[n]` only follow
      // msgid_plural, which already flagged the entry unsupported.
      const value = unquote(line.replace(/^msgstr(\[\d+\])?/, '').trim())
      msgstr = (msgstr ?? '') + (value ?? '')
      field = 'msgstr'
    } else {
      const continuation = unquote(line)
      if (continuation === null || field === null) continue
      if (field === 'msgid') msgid += continuation
      else msgstr += continuation
    }
  }
  flush()

  return { entries, keys }
}
