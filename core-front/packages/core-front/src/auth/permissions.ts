// Permission matching for the DSL module:resource:action (CONVENTIONS.md). Pure and
// isomorphic: the server guard and the client <Can> both call hasPermission. The
// server is the source of truth (it authorizes); the client only gates UI off the
// session mirror.

/**
 * Does the effective permission set grant `required`? Matching is segment-wise with
 * `*` wildcards: 'crm:*:read' grants 'crm:contacts:read'; '*:*:read' grants any :read.
 * A granted entry must have the same number of segments as the requirement.
 */
export function hasPermission(effective: string[], required: string): boolean {
  const want = required.split(':')
  return effective.some((granted) => {
    const have = granted.split(':')
    if (have.length !== want.length) return false
    return have.every((segment, i) => segment === '*' || segment === want[i])
  })
}
