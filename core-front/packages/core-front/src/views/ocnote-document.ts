import { Extension, getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyleKit } from '@tiptap/extension-text-style'
import FindAndReplace from '@tiptap/extension-find-and-replace'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'

// OpenCloud stores the document itself, with no wrapper or HTML conversion:
// https://github.com/opencloud-eu/web/blob/main/packages/web-pkg/src/editor/composables/strategies/tiptapJson.ts
export const ocNoteExtensions = [
  StarterKit.configure({ link: { openOnClick: false }, codeBlock: false }),
  Image.configure({ allowBase64: true, resize: { enabled: true } }),
  TableKit.configure({ table: { resizable: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Subscript,
  Superscript,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TextStyleKit,
  CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
  FindAndReplace.configure({ searchDebounceMs: 0 }),
  // OpenCloud's table-of-contents extension persists both heading anchors.
  Extension.create({
    name: 'ocnoteHeadingAnchors',
    addGlobalAttributes: () => [
      {
        types: ['heading'],
        attributes: { id: { default: null }, 'data-toc-id': { default: null } },
      },
    ],
  }),
]
const schema = getSchema(ocNoteExtensions)

/** Validate before Tiptap can silently discard unknown nodes, marks or attributes. */
export function parseOcNote(value: string): JSONContent {
  const doc: JSONContent = value.trim()
    ? JSON.parse(value)
    : { type: 'doc', content: [{ type: 'paragraph' }] }
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content))
    throw new Error('Invalid note file.')
  const check = (node: JSONContent) => {
    if (!node || typeof node !== 'object') throw new Error('Invalid note file.')
    const spec = schema.nodes[node.type ?? '']?.spec ?? schema.marks[node.type ?? '']?.spec
    if (
      !spec ||
      Object.keys(node.attrs ?? {}).some((key) => !Object.hasOwn(spec.attrs ?? {}, key))
    ) {
      throw new Error('This note contains formatting that this editor does not support.')
    }
    node.marks?.forEach(check)
    node.content?.forEach(check)
  }
  check(doc)
  // Empty notes can be created by OpenCloud before their first edit.
  if (doc.content.length === 0) doc.content = [{ type: 'paragraph' }]
  schema.nodeFromJSON(doc).check()
  return doc
}
