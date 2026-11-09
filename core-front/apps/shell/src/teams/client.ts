// Typed browser client for the Teams BFF (/api/teams/* → Go /api/v1/teams/*).
// Wire types mirror core/internal/teams/*_handler.go.

export type Role = 'owner' | 'member' | 'guest'

export interface Team {
  id: string
  name: string
  description: string
  role: Role
  member_count: number
  unread: number
}
export interface Member {
  user_id: string
  display_name: string
  email: string
  role: Role
  has_avatar?: boolean
}
export interface DirectoryUser {
  id: string
  display_name: string
  email: string
  has_avatar?: boolean
}
export interface Channel {
  id: string
  team_id: string
  kind: string
  name: string
  unread: number
  folder_id?: string | null
}
export interface DirectChat {
  id: string
  other_user: DirectoryUser
  unread: number
  last_message_at: string | null
}
/** kind "file" is a team file (/files/:id/download); deleted = gone or in a folder the viewer can't see. */
export interface Attachment {
  id: string
  filename: string
  mime: string
  size: number
  kind?: 'attachment' | 'file'
  deleted?: boolean
}
export interface Reaction {
  emoji: string
  count: number
  mine: boolean
}
export interface Message {
  id: string
  channel_id: string
  author_id: string
  author_name: string
  author_has_avatar?: boolean
  body: string
  created_at: string
  attachments: Attachment[]
  reactions: Reaction[]
}
export interface Folder {
  id: string
  name: string
  parent_id: string | null
  created_by: string
}
export interface TeamFile {
  id: string
  name: string
  folder_id: string | null
  mime: string
  size: number
  uploaded_by: string
  uploaded_by_name: string
  created_at: string
  shared_with: number
}
export interface FolderListing {
  folder: { id: string; name: string; parent_id: string | null } | null
  path: { id: string; name: string }[]
  folders: Folder[]
  files: TeamFile[]
}
export interface Share {
  user_id: string
  display_name: string
  email: string
}
export interface SharedFile {
  id: string
  name: string
  mime: string
  size: number
  team_id: string
  team_name: string
  shared_by_name: string
  created_at: string
}

/** An HTTP failure. `code` is Go's own error code (NOT_FOUND, LAST_OWNER…): a 404 without one
 * is an unmounted route (e.g. file storage not configured), not a missing record. */
export class TeamsApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(`/api/teams${path}`, {
    method,
    ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
    ...(body === undefined || isForm ? {} : { headers: { 'Content-Type': 'application/json' } }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null
    throw new TeamsApiError(res.status, err?.error?.message ?? res.statusText, err?.error?.code)
  }
  const text = res.status === 204 ? '' : await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const list = async <T>(path: string): Promise<T[]> => (await call<{ data: T[] }>('GET', path)).data
const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  return s.size ? `?${s}` : ''
}

// Teams
export const listTeams = () => list<Team>('')
export const createTeam = (name: string, description = '') => call<Team>('POST', '', { name, description })
export const getTeam = (id: string) => call<Team>('GET', `/${id}`)
export const updateTeam = (id: string, name: string, description = '') => call<Team>('PUT', `/${id}`, { name, description })
export const deleteTeam = (id: string) => call<void>('DELETE', `/${id}`)

// Members
export const listMembers = (team: string) => list<Member>(`/${team}/members`)
export const addMember = (team: string, userId: string, role: Role) => call<Member>('POST', `/${team}/members`, { user_id: userId, role })
export const setMemberRole = (team: string, userId: string, role: Role) => call<void>('PUT', `/${team}/members/${userId}`, { user_id: userId, role })
export const removeMember = (team: string, userId: string) => call<void>('DELETE', `/${team}/members/${userId}`)
export const directory = () => list<DirectoryUser>('/directory')

// Channels and direct chat
export const listChannels = (team: string) => list<Channel>(`/${team}/channels`)
export const createChannel = (team: string, name: string) => call<Channel>('POST', `/${team}/channels`, { name })
export const renameChannel = (team: string, channel: string, name: string) => call<Channel>('PUT', `/${team}/channels/${channel}`, { name })
export const deleteChannel = (team: string, channel: string) => call<void>('DELETE', `/${team}/channels/${channel}`)
/** folderId '' unlinks. */
export const linkFolder = (team: string, channel: string, folderId: string) =>
  call<Channel>('PUT', `/${team}/channels/${channel}`, { folder_id: folderId })
export const listDirect = () => list<DirectChat>('/direct')
export const orderChannels = (team: string, ids: string[]) => call<void>('PUT', `/${team}/channels/order`, { ids })
export const orderDirect = (ids: string[]) => call<void>('PUT', '/direct/order', { ids })
export const openDirect = (userId: string) => call<DirectChat>('POST', '/direct', { user_id: userId })

// Messages (newest first; `before` is an RFC3339 timestamp)
export const listMessages = (channel: string, before?: string, limit?: number) =>
  list<Message>(`/channels/${channel}/messages${q({ before, limit })}`)
export function postMessage(channel: string, body: string, mentions: string[] = [], files: File[] = []): Promise<Message> {
  if (files.length === 0) return call<Message>('POST', `/channels/${channel}/messages`, { body, mentions })
  const form = new FormData()
  form.append('body', body)
  for (const m of mentions) form.append('mentions', m)
  for (const f of files) form.append('files', f)
  return call<Message>('POST', `/channels/${channel}/messages`, form)
}
export const markRead = (channel: string) => call<void>('POST', `/channels/${channel}/read`)
export const toggleReaction = (message: string, emoji: string) =>
  call<{ reactions: Reaction[] }>('POST', `/messages/${message}/reactions`, { emoji })

// Files and folders
export const listFiles = (team: string, folder?: string) => call<FolderListing>('GET', `/${team}/files${q({ folder })}`)
export const createFolder = (team: string, name: string, parentId?: string) =>
  call<Folder>('POST', `/${team}/folders`, { name, parent_id: parentId ?? '' })
/** parentId: undefined = unchanged, '' = move to the root. */
export const updateFolder = (team: string, folder: string, patch: { name?: string; parent_id?: string }) =>
  call<Folder>('PUT', `/${team}/folders/${folder}`, patch)
export const deleteFolder = (team: string, folder: string) => call<void>('DELETE', `/${team}/folders/${folder}`)
export function uploadFile(team: string, file: File, folderId?: string): Promise<TeamFile> {
  const form = new FormData()
  form.append('file', file)
  if (folderId) form.append('folder_id', folderId)
  return call<TeamFile>('POST', `/${team}/files`, form)
}
/** folder_id: undefined = unchanged, '' = move to the root. */
export const updateFile = (team: string, file: string, patch: { name?: string; folder_id?: string }) =>
  call<TeamFile>('PUT', `/${team}/files/${file}`, patch)
export const deleteFile = (team: string, file: string) => call<void>('DELETE', `/${team}/files/${file}`)
export const getShares = (file: string) => list<Share>(`/files/${file}/shares`)
export const setShares = async (file: string, userIds: string[]) =>
  (await call<{ data: Share[] }>('PUT', `/files/${file}/shares`, { user_ids: userIds })).data
export const listShared = () => list<SharedFile>('/shared')
