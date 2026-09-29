'use client'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { unwrapActions, type Settled } from '../api/errors'

// Shared shape behind RelationOps/GraphOps/NotebookOps: a context of bound Server
// Action references the host mounts once (root layout) — client code never talks to
// Go directly, and Go authorizes every call from the session. `useOps()` reads null
// when the host mounted no provider; every consumer treats that as "render inert,
// not a crash," never as an error.
export function createOpsContext<T>() {
  const Context = createContext<T | null>(null)

  function Provider({ ops, children }: { ops: T | Settled<T>; children: ReactNode }) {
    // Server Actions return failures as values (settleAction); turn them back
    // into thrown ApiErrors here, once, for every consumer.
    const value = useMemo(() => unwrapActions(ops as object) as T, [ops])
    return <Context.Provider value={value}>{children}</Context.Provider>
  }

  function useOps(): T | null {
    return useContext(Context)
  }

  return { Provider, useOps }
}
