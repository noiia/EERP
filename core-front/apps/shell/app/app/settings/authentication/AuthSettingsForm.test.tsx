import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const saveAuthSettings = vi.fn()
const testAuthMethod = vi.fn()
vi.mock('@/lib/auth-settings', () => ({
  saveAuthSettings: (s: unknown) => saveAuthSettings(s),
  testAuthMethod: (m: string) => testAuthMethod(m),
}))

import AuthSettingsForm from './AuthSettingsForm'
import type { AuthSettingsView } from '@/lib/auth-settings'

const ldap = {
  label: 'Company directory',
  url: 'ldap://lldap:3890',
  start_tls: false,
  bind_dn: 'uid=admin',
  base_dn: 'dc=example,dc=com',
  user_filter: '',
  email_attr: '',
  name_attr: '',
  groups_attr: '',
  group_search_base: '',
  group_filter: '',
  has_bind_password: true,
}
const base: AuthSettingsView = {
  default: 'local',
  enabled: ['ldap'],
  ldap,
  oidc: [
    {
      id: 'google',
      label: 'Google',
      issuer: 'https://accounts.google.com',
      client_id: 'c',
      scopes: 'openid email',
      groups_claim: '',
      trust_email: false,
      has_client_secret: true,
    },
  ],
  role_mapping: [],
  default_role_id: null,
  erp_url: 'https://erp.example.com',
  callback_url: 'https://erp.example.com/api/auth/oidc/callback',
}
const roles = [
  { id: 'r1', name: 'Admin' },
  { id: 'r2', name: 'Sales' },
]

beforeEach(() => {
  saveAuthSettings.mockReset().mockResolvedValue({ ok: true })
  testAuthMethod.mockReset()
})

it('offers Local, LDAP and each provider as default method', () => {
  render(<AuthSettingsForm initial={base} roles={roles} />)
  expect(screen.getByRole('checkbox', { name: 'Company directory' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Google' })).toBeTruthy()
  fireEvent.mouseDown(screen.getByLabelText('Default method'))
  const opts = screen.getAllByRole('option').map((o) => o.textContent)
  expect(opts).toEqual(['Local', 'Company directory', 'Google'])
})

it('LLDAP defaults fills the preset', () => {
  render(<AuthSettingsForm initial={base} roles={roles} />)
  fireEvent.click(screen.getByRole('button', { name: 'LLDAP defaults' }))
  expect((screen.getByLabelText('User filter') as HTMLInputElement).value).toBe(
    '(&(objectClass=person)(uid={username}))',
  )
  expect((screen.getByLabelText('Email attribute') as HTMLInputElement).value).toBe('mail')
  expect((screen.getByLabelText('Name attribute') as HTMLInputElement).value).toBe('cn')
  expect((screen.getByLabelText('Groups attribute') as HTMLInputElement).value).toBe('memberOf')
})

it('keeps a stored secret write-only and submits it empty, stripping has_* and callback_url', async () => {
  render(<AuthSettingsForm initial={base} roles={roles} />)
  const pw = screen.getByLabelText('Bind password') as HTMLInputElement
  expect(pw.type).toBe('password')
  expect(pw.value).toBe('')
  expect(screen.getAllByText('Stored — leave empty to keep').length).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveAuthSettings).toHaveBeenCalled())
  const body = saveAuthSettings.mock.calls[0][0]
  expect(body.ldap.bind_password).toBe('')
  expect(body.oidc[0].client_secret).toBe('')
  expect(JSON.stringify(body)).not.toContain('has_')
  expect(body).not.toHaveProperty('callback_url')
})

it('shows the callback URL read-only', () => {
  render(<AuthSettingsForm initial={base} roles={roles} />)
  const cb = screen.getByLabelText('Callback URL') as HTMLInputElement
  expect(cb.value).toBe('https://erp.example.com/api/auth/oidc/callback')
  expect(cb.readOnly).toBe(true)
})

it('maps a group to a role id', async () => {
  render(<AuthSettingsForm initial={base} roles={roles} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }))
  fireEvent.change(screen.getByLabelText('Group'), { target: { value: 'staff' } })
  fireEvent.mouseDown(screen.getByLabelText('Role'))
  fireEvent.click(screen.getByRole('option', { name: 'Sales' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveAuthSettings).toHaveBeenCalled())
  expect(saveAuthSettings.mock.calls[0][0].role_mapping).toEqual([
    { group: 'staff', role_id: 'r2' },
  ])
})

it('shows the Go 400 message in an error alert', async () => {
  saveAuthSettings.mockResolvedValue({
    ok: false,
    message: 're-enter the secret when changing the server',
  })
  render(<AuthSettingsForm initial={base} roles={roles} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('re-enter the secret when changing the server')
})

it('Test connection calls testAuthMethod(ldap) and shows the message', async () => {
  testAuthMethod.mockResolvedValue({ ok: true, message: 'bind ok' })
  render(<AuthSettingsForm initial={base} roles={roles} />)
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  expect(await screen.findByText('bind ok')).toBeTruthy()
  expect(testAuthMethod).toHaveBeenCalledWith('ldap')
})

it('shows a provider discovery result under that provider, without LDAP', async () => {
  testAuthMethod.mockResolvedValue({ ok: true, message: 'discovery ok' })
  render(<AuthSettingsForm initial={{ ...base, ldap: null, enabled: [] }} roles={roles} />)
  fireEvent.click(screen.getByRole('button', { name: 'Test discovery' }))
  expect(await screen.findByText('discovery ok')).toBeTruthy()
  expect(testAuthMethod).toHaveBeenCalledWith('oidc:google')
})

it('shows a read-only callback URL for a newly added provider', () => {
  render(<AuthSettingsForm initial={base} roles={roles} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
  const cbs = screen.getAllByLabelText('Callback URL') as HTMLInputElement[]
  expect(cbs).toHaveLength(2)
  expect(cbs[1].readOnly).toBe(true)
  expect(cbs[1].value).toBe(base.callback_url)
})

it('remaps enabled and default when a provider id is renamed', async () => {
  render(
    <AuthSettingsForm
      initial={{ ...base, default: 'oidc:google', enabled: ['oidc:google'] }}
      roles={roles}
    />,
  )
  fireEvent.change(screen.getByLabelText('Identifier'), { target: { value: 'gg' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveAuthSettings).toHaveBeenCalled())
  const body = saveAuthSettings.mock.calls[0][0]
  expect(body.default).toBe('oidc:gg')
  expect(body.enabled).toEqual(['oidc:gg'])
})

it('never duplicates a provider id after a removal', async () => {
  const two = { ...base, oidc: [base.oidc[0], { ...base.oidc[0], id: 'oidc2' }] }
  render(<AuthSettingsForm initial={two} roles={roles} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1])
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveAuthSettings).toHaveBeenCalled())
  const ids = saveAuthSettings.mock.calls[0][0].oidc.map((o: { id: string }) => o.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toEqual(['oidc2', 'oidc3'])
})

it('clears typed secrets after a successful save and flags them stored', async () => {
  const fresh = {
    ...base,
    ldap: { ...ldap, has_bind_password: false },
    oidc: [{ ...base.oidc[0], has_client_secret: false }],
  }
  render(<AuthSettingsForm initial={fresh} roles={roles} />)
  fireEvent.change(screen.getByLabelText('Bind password'), { target: { value: 'pw' } })
  fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'sec' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved.')
  expect((screen.getByLabelText('Bind password') as HTMLInputElement).value).toBe('')
  expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
  expect(screen.getAllByText('Stored — leave empty to keep')).toHaveLength(2)
})
