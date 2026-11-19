package app

import "core/internal/auth/providers"

// SetDirectoryForTest swaps the LDAP directory behind the mounted routes.
func (a *App) SetDirectoryForTest(d providers.Directory) { a.extAuth.SetDirectory(d) }
