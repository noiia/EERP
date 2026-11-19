// A component stand-in for vi.mock factories: renders the props it received as JSON
// under data-testid=<name>, so a page test can assert what it passed each child.
//   vi.mock('@/components/X', async () => ({ default: (await import('@/test/props-stub')).propsStub('x') }))
export const propsStub = (name: string) =>
  function PropsStub(p: Record<string, unknown>) {
    return <div data-testid={name}>{JSON.stringify(p)}</div>
  }
