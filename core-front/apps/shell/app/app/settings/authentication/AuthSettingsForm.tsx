'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT, ViewBanner } from '@eerp/core-front'
import {
  saveAuthSettings,
  testAuthMethod,
  type AuthSettingsInput,
  type AuthSettingsView,
  type LDAPSettings,
  type OIDCSettings,
  type RoleMappingRow,
} from '@/lib/auth-settings'

const LLDAP = {
  user_filter: '(&(objectClass=person)(uid={username}))',
  email_attr: 'mail',
  name_attr: 'cn',
  groups_attr: 'memberOf',
}

const EMPTY_LDAP: LDAPSettings = {
  label: 'Company directory',
  url: '',
  start_tls: false,
  bind_dn: '',
  base_dn: '',
  user_filter: '',
  email_attr: '',
  name_attr: '',
  groups_attr: '',
  group_search_base: '',
  group_filter: '',
}

function newProvider(existing: OIDCSettings[]): OIDCSettings {
  const used = new Set(existing.map((o) => o.id))
  let n = Math.max(0, ...existing.map((o) => Number(/^oidc(\d+)$/.exec(o.id)?.[1] ?? 0))) + 1
  while (used.has(`oidc${n}`)) n++
  return {
    id: `oidc${n}`,
    label: '',
    issuer: '',
    client_id: '',
    scopes: 'openid email profile',
    groups_claim: '',
    trust_email: false,
  }
}

/** The PUT body: has_* flags and callback_url are read-only output; secrets default to "" (keep stored). */
function toInput(s: AuthSettingsView): AuthSettingsInput {
  const { callback_url: _cb, ...rest } = s
  void _cb
  const ldap = s.ldap
    ? (() => {
        const { has_bind_password: _h, ...l } = s.ldap
        void _h
        return {
          ...l,
          bind_password: l.bind_password ?? '',
          default_role_id: l.default_role_id || null,
        }
      })()
    : null
  const oidc = s.oidc.map(({ has_client_secret: _h, ...o }) => {
    void _h
    return {
      ...o,
      client_secret: o.client_secret ?? '',
      default_role_id: o.default_role_id || null,
      allowed_domains: (o.allowed_domains ?? []).map((d) => d.trim()).filter(Boolean),
    }
  })
  const role_mapping = s.role_mapping.map((r) => ({ ...r, method: r.method ?? '' }))
  return { ...rest, ldap, oidc, role_mapping }
}

export default function AuthSettingsForm({
  initial,
  roles,
}: {
  initial: AuthSettingsView
  roles: { id: string; name: string }[]
}) {
  const t = useT()
  const [s, setS] = useState<AuthSettingsView>(initial)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testMsgs, setTestMsgs] = useState<Record<string, { ok: boolean; text: string }>>({})

  const ldap = s.ldap
  const setLdap = (patch: Partial<LDAPSettings>) =>
    setS({ ...s, ldap: { ...(s.ldap ?? EMPTY_LDAP), ...patch } })
  const setOidc = (i: number, patch: Partial<OIDCSettings>) => {
    const oldId = s.oidc[i].id
    const next = { ...s, oidc: s.oidc.map((o, j) => (j === i ? { ...o, ...patch } : o)) }
    if (patch.id !== undefined && patch.id !== oldId) {
      const from = `oidc:${oldId}`
      const to = `oidc:${patch.id}`
      next.enabled = s.enabled.map((e) => (e === from ? to : e))
      next.role_mapping = s.role_mapping.map((r) => (r.method === from ? { ...r, method: to } : r))
      if (s.default === from) next.default = to
    }
    setS(next)
  }

  const methods = [
    { id: 'local', label: t('Local') },
    ...(ldap ? [{ id: 'ldap', label: ldap.label || t('Company directory (LDAP)') }] : []),
    ...s.oidc.map((o) => ({ id: `oidc:${o.id}`, label: o.label || o.id })),
  ]

  function toggle(id: string, on: boolean) {
    setS({ ...s, enabled: on ? [...s.enabled, id] : s.enabled.filter((e) => e !== id) })
  }

  async function save() {
    const res = await saveAuthSettings(toInput(s))
    if (res.ok) {
      setS((cur) => ({
        ...cur,
        ldap: cur.ldap && {
          ...cur.ldap,
          has_bind_password: cur.ldap.has_bind_password || !!cur.ldap.bind_password,
          bind_password: '',
        },
        oidc: cur.oidc.map((o) => ({
          ...o,
          has_client_secret: o.has_client_secret || !!o.client_secret,
          client_secret: '',
        })),
      }))
    }
    setMsg(
      res.ok
        ? { ok: true, text: t('Saved.') }
        : { ok: false, text: res.message || t('Could not save.') },
    )
  }

  async function test(method: string) {
    const res = await testAuthMethod(method)
    setTestMsgs((m) => ({
      ...m,
      [method]: { ok: res.ok, text: res.message || (res.ok ? t('OK') : t('Test failed.')) },
    }))
  }

  const stored = t('Stored — leave empty to keep')

  const defaultRoleSelect = (
    value: string | null | undefined,
    onChange: (v: string | null) => void,
  ) => (
    <TextField
      select
      label={t('Default role')}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
    >
      <MenuItem value="">{t('— none (refuse) —')}</MenuItem>
      {roles.map((r) => (
        <MenuItem key={r.id} value={r.id}>
          {r.name}
        </MenuItem>
      ))}
    </TextField>
  )
  const setMapping = (i: number, patch: Partial<RoleMappingRow>) =>
    setS({
      ...s,
      role_mapping: s.role_mapping.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    })

  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
      <TextField
        select
        label={t('Default method')}
        value={s.default}
        onChange={(e) => setS({ ...s, default: e.target.value })}
      >
        {methods.map((m) => (
          <MenuItem key={m.id} value={m.id}>
            {m.label}
          </MenuItem>
        ))}
      </TextField>

      <Stack>
        <Typography variant="subtitle1">{t('Alternatives')}</Typography>
        {methods
          .filter((m) => m.id !== 'local')
          .map((m) => (
            <FormControlLabel
              key={m.id}
              label={m.label}
              control={
                <Checkbox
                  checked={s.enabled.includes(m.id)}
                  onChange={(e) => toggle(m.id, e.target.checked)}
                />
              }
            />
          ))}
      </Stack>

      <TextField
        label={t('ERP public URL')}
        placeholder="https://erp.example.com"
        value={s.erp_url}
        onChange={(e) => setS({ ...s, erp_url: e.target.value })}
      />

      <Stack spacing={2}>
        <Typography variant="h6">{t('Company directory (LDAP)')}</Typography>
        {!ldap ? (
          <Button variant="outlined" onClick={() => setLdap({})} sx={{ alignSelf: 'flex-start' }}>
            {t('Configure LDAP')}
          </Button>
        ) : (
          <>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={() => setLdap(LLDAP)}>
                {t('LLDAP defaults')}
              </Button>
              <Button variant="outlined" onClick={() => void test('ldap')}>
                {t('Test connection')}
              </Button>
              <Button
                color="error"
                onClick={() =>
                  setS({
                    ...s,
                    ldap: null,
                    enabled: s.enabled.filter((e) => e !== 'ldap'),
                    role_mapping: s.role_mapping.filter((r) => r.method !== 'ldap'),
                    default: s.default === 'ldap' ? 'local' : s.default,
                  })
                }
              >
                {t('Remove')}
              </Button>
            </Stack>
            {testMsgs.ldap && (
              <ViewBanner status={testMsgs.ldap.ok ? 'info' : 'error'}>{testMsgs.ldap.text}</ViewBanner>
            )}
            <TextField
              label={t('Label')}
              value={ldap.label}
              onChange={(e) => setLdap({ label: e.target.value })}
            />
            <TextField
              label={t('Server URL')}
              placeholder="ldap://lldap:3890"
              value={ldap.url}
              onChange={(e) => setLdap({ url: e.target.value })}
            />
            <FormControlLabel
              label={t('Use StartTLS')}
              control={
                <Checkbox
                  checked={ldap.start_tls}
                  onChange={(e) => setLdap({ start_tls: e.target.checked })}
                />
              }
            />
            <TextField
              label={t('Bind DN')}
              value={ldap.bind_dn}
              onChange={(e) => setLdap({ bind_dn: e.target.value })}
            />
            <TextField
              label={t('Bind password')}
              type="password"
              autoComplete="new-password"
              value={ldap.bind_password ?? ''}
              onChange={(e) => setLdap({ bind_password: e.target.value })}
              helperText={ldap.has_bind_password ? stored : undefined}
            />
            <TextField
              label={t('Base DN')}
              value={ldap.base_dn}
              onChange={(e) => setLdap({ base_dn: e.target.value })}
            />
            <TextField
              label={t('User filter')}
              value={ldap.user_filter}
              onChange={(e) => setLdap({ user_filter: e.target.value })}
            />
            <TextField
              label={t('Email attribute')}
              value={ldap.email_attr}
              onChange={(e) => setLdap({ email_attr: e.target.value })}
            />
            <TextField
              label={t('Name attribute')}
              value={ldap.name_attr}
              onChange={(e) => setLdap({ name_attr: e.target.value })}
            />
            <TextField
              label={t('Groups attribute')}
              value={ldap.groups_attr}
              onChange={(e) => setLdap({ groups_attr: e.target.value })}
            />
            <TextField
              label={t('Group search base')}
              value={ldap.group_search_base}
              onChange={(e) => setLdap({ group_search_base: e.target.value })}
            />
            <TextField
              label={t('Group filter')}
              value={ldap.group_filter}
              onChange={(e) => setLdap({ group_filter: e.target.value })}
            />
            {defaultRoleSelect(ldap.default_role_id, (v) => setLdap({ default_role_id: v }))}
          </>
        )}
      </Stack>

      <Stack spacing={2}>
        <Typography variant="h6">{t('Single sign-on (OIDC)')}</Typography>
        {s.oidc.map((o, i) => (
          <Stack
            key={i}
            spacing={2}
            sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}
          >
            <TextField
              label={t('Identifier')}
              value={o.id}
              onChange={(e) => setOidc(i, { id: e.target.value })}
            />
            <TextField
              label={t('Label')}
              value={o.label}
              onChange={(e) => setOidc(i, { label: e.target.value })}
            />
            <TextField
              label={t('Issuer URL')}
              value={o.issuer}
              onChange={(e) => setOidc(i, { issuer: e.target.value })}
            />
            <TextField
              label={t('Client ID')}
              value={o.client_id}
              onChange={(e) => setOidc(i, { client_id: e.target.value })}
            />
            <TextField
              label={t('Client secret')}
              type="password"
              autoComplete="new-password"
              value={o.client_secret ?? ''}
              onChange={(e) => setOidc(i, { client_secret: e.target.value })}
              helperText={o.has_client_secret ? stored : undefined}
            />
            <TextField
              label={t('Scopes')}
              value={o.scopes}
              onChange={(e) => setOidc(i, { scopes: e.target.value })}
            />
            <TextField
              label={t('Groups claim')}
              value={o.groups_claim}
              onChange={(e) => setOidc(i, { groups_claim: e.target.value })}
            />
            <FormControlLabel
              label={t('Trust the provider’s email')}
              control={
                <Checkbox
                  checked={o.trust_email}
                  onChange={(e) => setOidc(i, { trust_email: e.target.checked })}
                />
              }
            />
            <TextField
              label={t('Allowed email domains')}
              placeholder="example.com, example.org"
              value={(o.allowed_domains ?? []).join(',')}
              onChange={(e) =>
                setOidc(i, { allowed_domains: e.target.value ? e.target.value.split(',') : [] })
              }
              helperText={t(
                'Comma-separated. Empty admits every account of this provider — restrict a public provider (Google, Microsoft).',
              )}
            />
            {defaultRoleSelect(o.default_role_id, (v) => setOidc(i, { default_role_id: v }))}
            <TextField
              label={t('Callback URL')}
              value={s.callback_url || `${s.erp_url || t('<ERP URL>')}/api/auth/oidc/callback`}
              slotProps={{ input: { readOnly: true } }}
            />
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={() => void test(`oidc:${o.id}`)}>
                {t('Test discovery')}
              </Button>
              <Button
                color="error"
                onClick={() =>
                  setS({
                    ...s,
                    oidc: s.oidc.filter((_, j) => j !== i),
                    enabled: s.enabled.filter((e) => e !== `oidc:${o.id}`),
                    role_mapping: s.role_mapping.filter((r) => r.method !== `oidc:${o.id}`),
                    default: s.default === `oidc:${o.id}` ? 'local' : s.default,
                  })
                }
              >
                {t('Remove')}
              </Button>
            </Stack>
            {testMsgs[`oidc:${o.id}`] && (
              <ViewBanner status={testMsgs[`oidc:${o.id}`].ok ? 'info' : 'error'}>
                {testMsgs[`oidc:${o.id}`].text}
              </ViewBanner>
            )}
          </Stack>
        ))}
        <Button
          variant="outlined"
          onClick={() => setS({ ...s, oidc: [...s.oidc, newProvider(s.oidc)] })}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('Add provider')}
        </Button>
      </Stack>

      <Stack spacing={2}>
        <Typography variant="h6">{t('Role mapping')}</Typography>
        {s.role_mapping.map((m, i) => (
          <Stack key={i} direction="row" spacing={1}>
            <TextField
              label={t('Group')}
              value={m.group}
              onChange={(e) => setMapping(i, { group: e.target.value })}
            />
            <TextField
              select
              label={t('Role')}
              value={m.role_id}
              sx={{ minWidth: 200 }}
              onChange={(e) => setMapping(i, { role_id: e.target.value })}
            >
              {roles.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  {r.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label={t('Method')}
              value={m.method ?? ''}
              sx={{ minWidth: 180 }}
              onChange={(e) => setMapping(i, { method: e.target.value })}
              slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
            >
              <MenuItem value="">{t('All methods')}</MenuItem>
              {methods
                .filter((x) => x.id !== 'local')
                .map((x) => (
                  <MenuItem key={x.id} value={x.id}>
                    {x.label}
                  </MenuItem>
                ))}
            </TextField>
            <Button
              color="error"
              onClick={() => setS({ ...s, role_mapping: s.role_mapping.filter((_, j) => j !== i) })}
            >
              {t('Remove')}
            </Button>
          </Stack>
        ))}
        <Button
          variant="outlined"
          onClick={() =>
            setS({
              ...s,
              role_mapping: [...s.role_mapping, { group: '', role_id: '', method: '' }],
            })
          }
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('Add mapping')}
        </Button>
      </Stack>

      <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>
        {t('Save')}
      </Button>
      {msg && <ViewBanner status={msg.ok ? 'info' : 'error'}>{msg.text}</ViewBanner>}
    </Stack>
  )
}
