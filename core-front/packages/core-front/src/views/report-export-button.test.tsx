import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReportExportButton } from './report-export-button'
import { useSessionStore, type Identity } from './session-store'

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

beforeEach(() => {
  useSessionStore.setState({ identity: null })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReportExportButton', () => {
  it('stays hidden when the session lacks the report permission', () => {
    useSessionStore.setState({ identity: identityWith(['crm:contacts:read']) })
    render(<ReportExportButton reportName="crm.statement" recordId="r1" permission="report:crm.statement:read" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders when granted (exact match or wildcard)', () => {
    useSessionStore.setState({ identity: identityWith(['*:*:*']) })
    render(<ReportExportButton reportName="crm.statement" recordId="r1" permission="report:crm.statement:read" />)
    expect(screen.getByRole('button', { name: 'Export to PDF' })).toBeInTheDocument()
  })

  it('POSTs to the BFF route and opens the returned download_url', async () => {
    useSessionStore.setState({ identity: identityWith(['*:*:*']) })
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ download_url: '/api/reports/pdf?key=x' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const openMock = vi.fn()
    vi.stubGlobal('open', openMock)

    render(<ReportExportButton reportName="crm.statement" recordId="r1" permission="report:crm.statement:read" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export to PDF' }))

    await waitFor(() => expect(openMock).toHaveBeenCalledWith('/api/reports/pdf?key=x', '_blank'))
    expect(fetchMock).toHaveBeenCalledWith('/api/reports/crm.statement/r1', { method: 'POST' })
  })

  it('shows a busy state while the request is in flight', async () => {
    useSessionStore.setState({ identity: identityWith(['*:*:*']) })
    let resolveFetch: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })),
    )
    vi.stubGlobal('open', vi.fn())

    render(<ReportExportButton reportName="crm.statement" recordId="r1" permission="report:crm.statement:read" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export to PDF' }))

    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeDisabled()

    resolveFetch(
      new Response(JSON.stringify({ download_url: '/x' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export to PDF' })).not.toBeDisabled())
  })

  it('shows an inline error and re-enables the button when the request fails', async () => {
    useSessionStore.setState({ identity: identityWith(['*:*:*']) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })))

    render(<ReportExportButton reportName="crm.statement" recordId="r1" permission="report:crm.statement:read" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export to PDF' }))

    expect(await screen.findByText('Could not generate the report.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export to PDF' })).not.toBeDisabled()
  })
})
