'use client'
import { useEffect } from 'react'
import { useSessionStore, type Identity } from '@eerp/core-front'

// Seeds the client session mirror from the server-resolved identity on first render
// and whenever it changes (e.g. after navigation). The server stays the source of
// truth; this only feeds permissions/identity into <Can> and other UI gating.
export function SessionHydrator({ identity }: { identity: Identity | null }) {
  useEffect(() => {
    useSessionStore.getState().setIdentity(identity)
  }, [identity])
  return null
}
