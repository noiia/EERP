import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AttachmentClient, AttachmentMeta } from '../api/attachments-client'
import type { FieldDescriptor } from './descriptor'
import { AttachmentClientProvider } from './file-widgets'
import { fieldWidget, type WidgetProps } from './widgets'

// State-machine tests for boolean/file, mirroring picture-widgets.test.tsx's
// coverage of boolean/picture: empty -> uploaded -> replaced -> deleted, and
// the reconcile rule (the service is authoritative for the draft flag).

const meta: AttachmentMeta = {
  id: 'a1',
  table_name: 'property_management_equipment',
  record_id: 'r1',
  field: 'billing_of_buy',
  filename: 'invoice.pdf',
  mime: 'application/pdf',
  size: 3,
}

function stubClient(overrides: Partial<AttachmentClient> = {}): AttachmentClient {
  return {
    find: vi.fn(async () => null),
    upload: vi.fn(async () => meta),
    remove: vi.fn(async () => undefined),
    url: (id: string) => `/api/attachments/${id}`,
    ...overrides,
  }
}

function Harness({
  field,
  client,
  onChange,
  initialValue,
  recordId,
  disabled,
}: {
  field: FieldDescriptor
  client: AttachmentClient
  onChange: (next: unknown) => void
  initialValue: boolean
  recordId: string | null
  disabled?: boolean
}) {
  const [value, setValue] = useState<unknown>(initialValue)
  const Widget = fieldWidget(field)
  return (
    <AttachmentClientProvider client={client}>
      <Widget
        field={field}
        value={value}
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
        entity="property_management_equipment"
        recordId={recordId}
        disabled={disabled}
      />
    </AttachmentClientProvider>
  )
}

function renderWidget(
  field: FieldDescriptor,
  client: AttachmentClient,
  props: Partial<WidgetProps> = {},
) {
  const onChange = vi.fn()
  const view = render(
    <Harness
      field={field}
      client={client}
      disabled={props.disabled}
      onChange={onChange}
      initialValue={Boolean(props.value)}
      recordId={props.recordId !== undefined ? props.recordId : 'r1'}
    />,
  )
  return { onChange, view }
}

const billingField: FieldDescriptor = {
  name: 'billing_of_buy',
  label: 'Billing of buy',
  type: 'boolean',
  widget: 'file',
}

describe('boolean/file', () => {
  it('shows the unsaved-record hint instead of an upload surface with no id yet', () => {
    renderWidget(billingField, stubClient(), { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })

  it('resolves the anchor on mount and reconciles the flag when a file already exists', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    const { onChange } = renderWidget(billingField, client, { value: false })
    await waitFor(() =>
      expect(client.find).toHaveBeenCalledWith({
        table: 'property_management_equipment',
        recordId: 'r1',
        field: 'billing_of_buy',
      }),
    )
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('uploading sets the flag and shows the filename as a download link', async () => {
    const client = stubClient()
    const { onChange } = renderWidget(billingField, client, { value: false })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pdf-bytes'], 'invoice.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(client.upload).toHaveBeenCalledWith(
      { table: 'property_management_equipment', recordId: 'r1', field: 'billing_of_buy' },
      file,
      'invoice.pdf',
    ))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true))
    const link = await screen.findByText('invoice.pdf')
    expect(link.closest('a')).toHaveAttribute('href', '/api/attachments/a1')
  })

  it('deleting clears the flag and removes the download link', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    const { onChange } = renderWidget(billingField, client, { value: true })
    await screen.findByText('invoice.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(client.remove).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false))
    expect(screen.queryByText('invoice.pdf')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument()
  })

  it('surfaces a failed find as an inline error', async () => {
    const client = stubClient({ find: vi.fn(async () => Promise.reject(new Error('boom'))) })
    renderWidget(billingField, client)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})
