'use client'
import Button from '@mui/material/Button'
import Link from 'next/link'
import { byPrefixAndName, FontAwesomeIcon, T } from '@eerp/core-front'

// Links to Global settings' Accounts accordion — e.g. the username "@"
// display toggle — rather than duplicating a settings surface here. A
// dedicated Client Component: the host page (Settings → Users) is a Server
// Component, and passing `next/link`'s Link component as MUI Button's
// `component` prop from server to client code isn't serializable (functions
// can't cross that boundary as props) — importing Link here instead keeps it
// entirely within the client bundle.
export default function UsersSettingsButton() {
  return (
    <Button
      component={Link}
      href="/settings/appearance"
      variant="outlined"
      startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas['gear']} size="sm" />}
    >
      <T text="Settings" />
    </Button>
  )
}
