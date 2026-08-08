import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PictureClient, PictureMeta } from '../api/pictures-client'
import type { FieldDescriptor } from './descriptor'
import { PictureClientProvider, PictureSizeProvider } from './picture-widgets'
import { fieldWidget, type WidgetProps } from './widgets'

// State-machine tests for the picture-backed boolean widgets, with the picture
// client stubbed through the provider (no network): empty -> uploaded/drawn ->
// saved -> reset, and the reconcile rule (the service is authoritative for the
// draft flag).

const meta: PictureMeta = {
  id: 'p1',
  table_name: 'contact',
  record_id: 'r1',
  field: 'photo',
  mime: 'image/png',
  size: 3,
}

function stubClient(overrides: Partial<PictureClient> = {}): PictureClient {
  return {
    find: vi.fn(async () => null),
    upload: vi.fn(async () => meta),
    remove: vi.fn(async () => undefined),
    url: (id: string) => `/api/pictures/${id}`,
    ...overrides,
  }
}

/**
 * Stateful harness: the widgets reconcile the flag against the live draft
 * value, so `value` must track onChange the way the form store's draft does.
 */
function Harness({
  field,
  client,
  onChange,
  initialValue,
  recordId,
  sizeOverride,
  disabled,
}: {
  field: FieldDescriptor
  client: PictureClient
  onChange: (next: unknown) => void
  initialValue: boolean
  recordId: string | null
  sizeOverride?: { width: number; height: number } | null
  disabled?: boolean
}) {
  const [value, setValue] = useState<unknown>(initialValue)
  const Widget = fieldWidget(field)
  return (
    <PictureClientProvider client={client}>
      <PictureSizeProvider size={sizeOverride}>
        <Widget
          field={field}
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
          entity="contact"
          recordId={recordId}
          disabled={disabled}
        />
      </PictureSizeProvider>
    </PictureClientProvider>
  )
}

function renderWidget(
  field: FieldDescriptor,
  client: PictureClient,
  props: Partial<WidgetProps> & { sizeOverride?: { width: number; height: number } | null } = {},
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
      sizeOverride={props.sizeOverride}
    />,
  )
  return { onChange, view }
}

const pictureField: FieldDescriptor = {
  name: 'photo',
  label: 'Photo',
  type: 'boolean',
  widget: 'picture',
}
const signatureField: FieldDescriptor = {
  name: 'signed',
  label: 'Signature',
  type: 'boolean',
  widget: 'signature',
}

describe('boolean/picture', () => {
  it('renders a hint instead of an upload surface before the record exists', () => {
    const client = stubClient()
    renderWidget(pictureField, client, { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
    expect(client.find).not.toHaveBeenCalled()
  })

  it('empty anchor: clicking the placeholder uploads a file and flips the flag true', async () => {
    const client = stubClient()
    const { onChange } = renderWidget(pictureField, client)

    const placeholder = await screen.findByTestId('picture-placeholder')
    expect(placeholder).toHaveAttribute('aria-label', 'Upload')
    const input = placeholder.querySelector('input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'me.png', { type: 'image/png' })] },
    })

    await waitFor(() => expect(client.upload).toHaveBeenCalled())
    expect(client.upload).toHaveBeenCalledWith(
      { table: 'contact', recordId: 'r1', field: 'photo' },
      expect.anything(),
      'me.png',
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true))
    // The stored picture now renders inside the same box, re-labeled to Replace.
    expect(await screen.findByRole('img', { name: 'Photo' })).toHaveAttribute(
      'src',
      '/api/pictures/p1',
    )
    expect(screen.getByTestId('picture-placeholder')).toHaveAttribute('aria-label', 'Replace')
  })

  it('existing picture: shows the thumbnail and deletes back to false via the corner cross', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    const { onChange } = renderWidget(pictureField, client, { value: true })

    expect(await screen.findByRole('img', { name: 'Photo' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('picture-delete'))

    await waitFor(() => expect(client.remove).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false))
    expect(screen.getByTestId('picture-placeholder')).toHaveAttribute('aria-label', 'Upload')
    // No picture left to delete — the cross is gone entirely, not just hidden.
    expect(screen.queryByTestId('picture-delete')).not.toBeInTheDocument()
  })

  it('has no delete cross when there is no picture yet', async () => {
    const client = stubClient()
    renderWidget(pictureField, client)
    await screen.findByTestId('picture-placeholder')
    expect(screen.queryByTestId('picture-delete')).not.toBeInTheDocument()
  })

  it('has no delete cross while disabled — nothing to click even if a picture exists', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    renderWidget(pictureField, client, { value: true, disabled: true })
    await screen.findByRole('img', { name: 'Photo' })
    expect(screen.queryByTestId('picture-delete')).not.toBeInTheDocument()
  })

  it('clicking an existing picture re-opens the file picker to replace it', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    renderWidget(pictureField, client, { value: true })

    await screen.findByRole('img', { name: 'Photo' })
    const placeholder = screen.getByTestId('picture-placeholder')
    const input = placeholder.querySelector('input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'new.png', { type: 'image/png' })] },
    })

    await waitFor(() =>
      expect(client.upload).toHaveBeenCalledWith(
        { table: 'contact', recordId: 'r1', field: 'photo' },
        expect.anything(),
        'new.png',
      ),
    )
  })

  it('the file input is disabled while busy or read-only, so clicking the box does nothing', async () => {
    const client = stubClient()
    renderWidget(pictureField, client, { disabled: true })
    const placeholder = await screen.findByTestId('picture-placeholder')
    expect(placeholder.querySelector('input[type="file"]')).toBeDisabled()
  })

  it('reconciles a stale true flag when the service has no picture', async () => {
    const client = stubClient()
    const { onChange } = renderWidget(pictureField, client, { value: true })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false))
  })

  it('renders a ringed placeholder at the default size when there is no picture yet', async () => {
    const client = stubClient()
    renderWidget(pictureField, client)
    const placeholder = await screen.findByTestId('picture-tile')
    expect(placeholder).toHaveStyle({ width: '160px', height: '96px' })
  })

  it('sizes the placeholder from widgetOptions.width/height (module-declared, resizable)', async () => {
    const client = stubClient()
    const sizedField: FieldDescriptor = {
      ...pictureField,
      widgetOptions: { width: 240, height: 240 },
    }
    renderWidget(sizedField, client)
    const placeholder = await screen.findByTestId('picture-tile')
    expect(placeholder).toHaveStyle({ width: '240px', height: '240px' })
  })

  it('sizes the loaded thumbnail from the same widgetOptions, not a fixed size', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    const sizedField: FieldDescriptor = {
      ...pictureField,
      widgetOptions: { width: 240, height: 240 },
    }
    renderWidget(sizedField, client, { value: true })
    await screen.findByRole('img', { name: 'Photo' })
    // The tile carries the pixel size; the label box (and the img inside it)
    // fills it at 100%/100%.
    expect(screen.getByTestId('picture-tile')).toHaveStyle({
      width: '240px',
      height: '240px',
    })
  })

  it('an admin-configured PictureSizeProvider override wins over widgetOptions', async () => {
    const client = stubClient()
    const sizedField: FieldDescriptor = {
      ...pictureField,
      widgetOptions: { width: 240, height: 240 },
    }
    renderWidget(sizedField, client, { sizeOverride: { width: 400, height: 400 } })
    const placeholder = await screen.findByTestId('picture-tile')
    expect(placeholder).toHaveStyle({ width: '400px', height: '400px' })
  })

  it('with no PictureSizeProvider override, falls back to widgetOptions as before (regression)', async () => {
    const client = stubClient()
    const sizedField: FieldDescriptor = {
      ...pictureField,
      widgetOptions: { width: 240, height: 240 },
    }
    renderWidget(sizedField, client)
    const placeholder = await screen.findByTestId('picture-tile')
    expect(placeholder).toHaveStyle({ width: '240px', height: '240px' })
  })

  it('ignores non-numeric widgetOptions.width/height and falls back to the default size', async () => {
    const client = stubClient()
    const badField: FieldDescriptor = {
      ...pictureField,
      widgetOptions: { width: 'huge' as unknown as number },
    }
    renderWidget(badField, client)
    const placeholder = await screen.findByTestId('picture-tile')
    expect(placeholder).toHaveStyle({ width: '160px', height: '96px' })
  })

  it('hideLabel: true suppresses the label but still renders the placeholder', async () => {
    const client = stubClient()
    renderWidget({ ...pictureField, hideLabel: true }, client)
    expect(screen.queryByText('Photo')).not.toBeInTheDocument()
    expect(await screen.findByTestId('picture-placeholder')).toBeInTheDocument()
  })
})

describe('boolean/signature', () => {
  beforeEach(() => {
    // jsdom ships no canvas: toBlob is stubbed to exercise the export path.
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob(['png-bytes'], { type: 'image/png' }))
    }
  })
  afterEach(() => {
    // @ts-expect-error restore jsdom's canvas-less state
    delete HTMLCanvasElement.prototype.toBlob
  })

  it('walks empty -> drawn -> saved -> reset', async () => {
    const client = stubClient()
    const { onChange } = renderWidget(signatureField, client)

    // empty: canvas present, Done/Reset inert
    const canvas = await screen.findByRole('img', { name: 'Signature' })
    expect(screen.getByText('Done').closest('button')).toBeDisabled()
    expect(screen.getByText('Reset').closest('button')).toBeDisabled()

    // drawn: any stroke marks the field signed
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 })
    fireEvent.pointerUp(canvas)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByText('Done').closest('button')).toBeEnabled()

    // saved: Done exports PNG -> picture service; the image replaces the canvas
    fireEvent.click(screen.getByText('Done'))
    await waitFor(() =>
      expect(client.upload).toHaveBeenCalledWith(
        { table: 'contact', recordId: 'r1', field: 'signed' },
        expect.anything(),
        'signed.png',
      ),
    )
    // The canvas (also role img) gives way to the stored image.
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Signature' })).toHaveAttribute(
        'src',
        '/api/pictures/p1',
      ),
    )
    expect(screen.queryByText('Done')).not.toBeInTheDocument()

    // reset: deletes the picture, flips false, returns to an empty canvas
    fireEvent.click(screen.getByText('Reset'))
    await waitFor(() => expect(client.remove).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false))
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Signature' }).tagName).toBe('CANVAS'),
    )
  })

  it('renders a saved signature from the service on load', async () => {
    const client = stubClient({ find: vi.fn(async () => meta) })
    renderWidget(signatureField, client, { value: true })
    // waitFor, not findByRole: the pre-load canvas also carries role img.
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Signature' })).toHaveAttribute(
        'src',
        '/api/pictures/p1',
      ),
    )
    expect(screen.getByText('Reset').closest('button')).toBeEnabled()
  })

  it('shows the hint before the record exists', () => {
    const client = stubClient()
    renderWidget(signatureField, client, { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })

  it('hideLabel: true suppresses the label but still renders the canvas', () => {
    const client = stubClient()
    renderWidget({ ...signatureField, hideLabel: true }, client)
    expect(screen.queryByText('Signature')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Signature' })).toBeInTheDocument()
  })
})
