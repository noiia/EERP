'use client'
import { useEffect } from 'react'
import { connectPresenceSocket, disconnectPresenceSocket, useSessionStore } from '@eerp/core-front'

// Opens the live presence WebSocket once a session mirror exists (login
// resolved client-side) and tears it down when it disappears (logout) or on
// unmount. Renders nothing — the twin of ModulesInit/LocaleSync's "small
// always-mounted client component wired once at the root" shape. The socket
// itself talks directly to core-back, not through Next — see
// presence-store.ts's own doc comment / docs/adr/ADR-019-user-presence-websocket.md.
export function PresenceInit() {
  const hasIdentity = useSessionStore((s) => s.identity !== null)

  useEffect(() => {
    if (!hasIdentity) {
      disconnectPresenceSocket()
      return
    }
    connectPresenceSocket()
    return () => disconnectPresenceSocket()
  }, [hasIdentity])

  return null
}
