import {
  normalizeLayout,
  type FieldDescriptor,
  type LayoutFieldNode,
  type LayoutNode,
  type ViewDescriptor,
} from '../views/descriptor'

// The inheritance engine (docs/roadmaps/view-customization.md, Phase 3): a module
// reshapes ANOTHER module's view without touching its code, the same "declare,
// don't patch" discipline the backend's crminheritdemo already proves for the ORM
// side. Operations are DATA — tagged records, never functions — so they cross the
// RSC boundary exactly like every other descriptor piece. applyExtension is pure:
// given a descriptor and an operation list, it returns a NEW descriptor; the
// registry is the only caller, applying extensions once at registration and
// serving the merged result forever after (renderers stay extension-unaware by
// design — the moment one inspects `extends`, the architecture has failed).

export type LayoutPosition = 'before' | 'after' | 'first' | 'last'

export interface AddFieldOp {
  op: 'addField'
  field: FieldDescriptor
  /** Anchor: an existing field name or layout node id. Omitted ⇒ appended at
   * the top level (position defaults to 'last'). */
  target?: string
  /** Defaults to 'after' when `target` is given, 'last' when it's omitted. */
  position?: LayoutPosition
}

export interface RemoveFieldOp {
  op: 'removeField'
  name: string
}

export interface SetFieldOp {
  op: 'setField'
  name: string
  /** Shallow-merged onto the existing field (label/type/required/readOnly/states,
   * or any other FieldDescriptor property). Renaming via `patch.name` is rejected
   * — a name change would orphan every layout reference to the field. */
  patch: Partial<FieldDescriptor>
}

export interface MoveOp {
  op: 'move'
  /** What moves — EXACTLY ONE of `name` (an existing field) or `id` (an existing
   * layout node, container or field-with-no-id — use `name` for fields instead). */
  name?: string
  id?: string
  target: string
  position: LayoutPosition
}

export interface AddNodeOp {
  op: 'addNode'
  /**
   * A new layout node (typically a group/row/section, possibly nested) — a
   * RESTRUCTURING op: "wrap these already-placed fields into a new
   * container". Every field-leaf inside `node` must reference a field that
   * already exists (this extension's own prior `addField` ops, or the base)
   * — addNode never introduces new field data, only new grouping. Each
   * referenced field is EXTRACTED from wherever it currently sits before the
   * new node is inserted, so it ends up living ONLY inside the new
   * container, not duplicated — this is what makes "reorganize a base
   * view's flat fields into a two-column layout" a single operation instead
   * of a manual move-by-move reconstruction.
   */
  node: LayoutNode
  target: string
  position: LayoutPosition
}

export interface SetDescriptorOp {
  op: 'setDescriptor'
  /** View-level knobs only — never entity/viewType/fields/layout, which have
   * their own dedicated operations (or are structural and shouldn't be
   * extension-patched at all). */
  patch: Partial<Pick<ViewDescriptor, 'formPath' | 'createPermission' | 'permissions'>>
}

export type Operation =
  | AddFieldOp
  | RemoveFieldOp
  | SetFieldOp
  | MoveOp
  | AddNodeOp
  | SetDescriptorOp

export interface ViewExtension {
  /** The base route's path — the registry's natural key (e.g. '/crm/:id'). */
  path: string
  operations: Operation[]
}

// ── layout tree surgery ─────────────────────────────────────────────────────

function cloneNode(node: LayoutNode): LayoutNode {
  return node.kind === 'field' ? { ...node } : { ...node, children: node.children.map(cloneNode) }
}

function isFieldMatch(node: LayoutNode, name: string): boolean {
  return node.kind === 'field' && node.name === name
}

function isContainerIdMatch(node: LayoutNode, id: string): boolean {
  return node.kind !== 'field' && node.id === id
}

/**
 * Remove the first node (depth-first, left-to-right) matching `matches` from
 * the tree. Returns the removed node (for `move`'s reinsertion) and the tree
 * without it — null when nothing matched.
 */
function extract(
  nodes: LayoutNode[],
  matches: (n: LayoutNode) => boolean,
): [LayoutNode | null, LayoutNode[]] {
  const rest: LayoutNode[] = []
  let removed: LayoutNode | null = null
  for (const node of nodes) {
    if (!removed && matches(node)) {
      removed = node
      continue
    }
    if (!removed && node.kind !== 'field') {
      const [childRemoved, childRest] = extract(node.children, matches)
      if (childRemoved) {
        removed = childRemoved
        rest.push({ ...node, children: childRest })
        continue
      }
    }
    rest.push(node)
  }
  return [removed, rest]
}

/**
 * Insert `newNode` at `target` + `position`. 'before'/'after' insert as a
 * SIBLING of the target anchor (a field name or a container id), wherever it
 * lives in the tree. 'first'/'last' insert as the first/last CHILD of a
 * target CONTAINER (its `id` — a field/leaf target can't hold children).
 *
 * `target` omitted ⇒ 'first'/'last' apply at the edge of the TOP-LEVEL array:
 * when that edge (first or last top-level node, matching `position`) is
 * itself a container, the new node becomes its first/last CHILD — so a
 * target-less `addField` lands inside the SAME visual group as its
 * neighbors, which is what "just add it, I don't care where" means for the
 * common case (one implicit top-level group wrapping the whole form). When
 * the edge is a bare field leaf (a hand-authored flat top-level layout with
 * no wrapping container) or the tree is empty, it inserts as a top-level
 * sibling instead — there is no container to descend into.
 * ('before'/'after' need an anchor and are rejected without one.)
 */
function insertAt(
  nodes: LayoutNode[],
  newNode: LayoutNode,
  target: string | undefined,
  position: LayoutPosition,
  opLabel: string,
): LayoutNode[] {
  if (target === undefined) {
    if (position !== 'first' && position !== 'last') {
      throw new Error(`${opLabel}: position "${position}" requires a target`)
    }
    if (nodes.length === 0) return [newNode]
    const edgeIndex = position === 'first' ? 0 : nodes.length - 1
    const edge = nodes[edgeIndex]
    if (edge.kind === 'field') {
      return position === 'first' ? [newNode, ...nodes] : [...nodes, newNode]
    }
    const children = position === 'first' ? [newNode, ...edge.children] : [...edge.children, newNode]
    const updatedEdge = { ...edge, children }
    return position === 'first'
      ? [updatedEdge, ...nodes.slice(1)]
      : [...nodes.slice(0, -1), updatedEdge]
  }

  if (position === 'first' || position === 'last') {
    let found = false
    const walk = (list: LayoutNode[]): LayoutNode[] =>
      list.map((n) => {
        if (found || n.kind === 'field') return n
        if (n.id === target) {
          found = true
          const children = position === 'first' ? [newNode, ...n.children] : [...n.children, newNode]
          return { ...n, children }
        }
        return { ...n, children: walk(n.children) }
      })
    const result = walk(nodes)
    if (!found) {
      throw new Error(
        `${opLabel}: target container id "${target}" not found (first/last requires a container id, not a field name)`,
      )
    }
    return result
  }

  // before / after: sibling insert next to the anchor, wherever it lives.
  let found = false
  const walk = (list: LayoutNode[]): LayoutNode[] => {
    const out: LayoutNode[] = []
    for (const n of list) {
      if (!found && (isFieldMatch(n, target) || isContainerIdMatch(n, target))) {
        found = true
        if (position === 'before') out.push(newNode, n)
        else out.push(n, newNode)
        continue
      }
      if (n.kind === 'field') {
        out.push(n)
        continue
      }
      out.push({ ...n, children: walk(n.children) })
    }
    return out
  }
  const result = walk(nodes)
  if (!found) throw new Error(`${opLabel}: target "${target}" not found`)
  return result
}

/**
 * Apply an extension's operations to a descriptor, in order — a PURE function
 * returning a NEW descriptor; the input is never mutated (every mutation
 * clones the node it touches). Normalizes the layout first, so operations
 * always see a concrete tree even when the base declared no explicit
 * `layout` — the result carries an explicit `layout` from then on.
 *
 * Throws, naming the operation and its target/field, on: an addField name
 * that already exists, a removeField/setField/move target that doesn't
 * exist, an addNode field-leaf not already declared, or a malformed move
 * (name and id both given, or neither).
 */
export function applyExtension<T>(
  descriptor: ViewDescriptor<T>,
  operations: Operation[],
): ViewDescriptor<T> {
  let fields = [...descriptor.fields]
  let layout = normalizeLayout(descriptor).map(cloneNode)
  let overrides: Partial<ViewDescriptor<T>> = {}

  for (const op of operations) {
    switch (op.op) {
      case 'addField': {
        if (fields.some((f) => f.name === op.field.name)) {
          throw new Error(`addField: field "${op.field.name}" already exists`)
        }
        fields = [...fields, op.field]
        const leaf: LayoutFieldNode = { kind: 'field', name: op.field.name }
        const position = op.position ?? (op.target !== undefined ? 'after' : 'last')
        layout = insertAt(layout, leaf, op.target, position, `addField "${op.field.name}"`)
        break
      }
      case 'removeField': {
        if (!fields.some((f) => f.name === op.name)) {
          throw new Error(`removeField: field "${op.name}" not found`)
        }
        fields = fields.filter((f) => f.name !== op.name)
        const [removed, rest] = extract(layout, (n) => isFieldMatch(n, op.name))
        if (!removed) throw new Error(`removeField: field "${op.name}" not found in layout`)
        layout = rest
        break
      }
      case 'setField': {
        const existing = fields.find((f) => f.name === op.name)
        if (!existing) throw new Error(`setField: field "${op.name}" not found`)
        if (op.patch.name !== undefined && op.patch.name !== op.name) {
          throw new Error(`setField "${op.name}": renaming via patch.name is not allowed`)
        }
        const patched: FieldDescriptor = { ...existing, ...op.patch, name: op.name }
        fields = fields.map((f) => (f.name === op.name ? patched : f))
        break
      }
      case 'move': {
        if ((op.name != null) === (op.id != null)) {
          throw new Error('move: exactly one of name or id must be given')
        }
        const label = op.name ? `field "${op.name}"` : `node id "${op.id}"`
        const matcher = op.name
          ? (n: LayoutNode) => isFieldMatch(n, op.name as string)
          : (n: LayoutNode) => isContainerIdMatch(n, op.id as string)
        const [removed, rest] = extract(layout, matcher)
        if (!removed) throw new Error(`move: ${label} not found`)
        layout = insertAt(rest, removed, op.target, op.position, `move ${label}`)
        break
      }
      case 'addNode': {
        const names = new Set(fields.map((f) => f.name))
        const leafNames: string[] = []
        const checkLeaves = (n: LayoutNode): void => {
          if (n.kind === 'field') {
            if (!names.has(n.name)) {
              throw new Error(`addNode: field "${n.name}" is not declared in fields`)
            }
            leafNames.push(n.name)
            return
          }
          for (const child of n.children) checkLeaves(child)
        }
        checkLeaves(op.node)
        // Extract every referenced field from its CURRENT position first —
        // the new node becomes its new (and only) home, never a duplicate.
        for (const leafName of leafNames) {
          const [, rest] = extract(layout, (n) => isFieldMatch(n, leafName))
          layout = rest
        }
        layout = insertAt(layout, cloneNode(op.node), op.target, op.position, 'addNode')
        break
      }
      case 'setDescriptor': {
        overrides = { ...overrides, ...op.patch }
        break
      }
      default: {
        const exhaustive: never = op
        throw new Error(`applyExtension: unknown operation "${(exhaustive as Operation).op}"`)
      }
    }
  }

  return { ...descriptor, ...overrides, fields, layout }
}
