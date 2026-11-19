import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'

// React's client renderer (what @testing-library/react uses) can't render async
// Server Components. A page test awaits the page itself; this resolves the async
// components nested in what it returned (sections fetching their own data), so the
// whole tree renders. Sync components (MUI, client components) are left to React.
type AnyProps = { children?: ReactNode }

const isAsync = (fn: unknown): fn is (p: unknown) => Promise<ReactNode> =>
  typeof fn === 'function' && fn.constructor.name === 'AsyncFunction'

export async function resolveServerTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerTree))
  if (!isValidElement(node)) return node
  const el = node as ReactElement<AnyProps>
  if (isAsync(el.type)) return resolveServerTree(await el.type(el.props))
  if (el.props.children === undefined) return el
  return cloneElement(el, undefined, await resolveServerTree(el.props.children))
}
