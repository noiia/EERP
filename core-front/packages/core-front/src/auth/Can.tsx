'use client'
import type { ReactNode } from 'react'
import { useSessionStore } from '../views/session-store'
import { hasPermission } from './permissions'

// Client UI gating off the session mirror. This is convenience only — never a
// security boundary. The server authorizes every read/write; <Can> just hides
// controls the user can't use.

// Stable reference for the "no identity" case — returning a fresh [] from the
// selector would make zustand see a new snapshot every render and loop forever.
const NO_PERMISSIONS: string[] = []

/** True if the current session's effective permissions grant `required`. */
export function usePermission(required: string): boolean {
  const permissions = useSessionStore((s) => s.identity?.permissions ?? NO_PERMISSIONS)
  return hasPermission(permissions, required)
}

export interface CanProps {
  permission: string
  children: ReactNode
  /** Rendered when the permission is missing (defaults to nothing). */
  fallback?: ReactNode
}

export function Can({ permission, children, fallback = null }: CanProps) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>
}
