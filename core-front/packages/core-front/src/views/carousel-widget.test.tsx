import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PictureClient, PictureMeta } from '../api/pictures-client'
import type { FieldDescriptor } from './descriptor'
import { PictureClientProvider } from './picture-widgets'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import { fieldWidget, type WidgetProps } from './widgets'

// relation/carousel: each embedded row is one photo, resolved through its
// OWN picture anchor (relatedEntity, row.id, pictureField) — two ops
// contexts wired together (RelationOps for the rows, a PictureClient for
// each row's own bytes).

const photoField: FieldDescriptor = {
  name: 'photos',
  label: 'Photos',
  type: 'relation',
  widget: 'carousel',
  widgetOptions: { max: 2 },
  relation: { entity: 'property_management_photo', kind: 'one2many', inverseField: 'property_management_id' },
}

function stubOps(overrides: Partial<RelationOps> = {}): RelationOps {
  return {
    list: vi.fn(async () => [] as RelationRecord[]),
    get: vi.fn(),
    create: vi.fn(async (_entity: string, body: Record<string, unknown>) => ({ id: 'new-photo', ...body })),
    remove: vi.fn(async () => undefined),
    ...overrides,
  }
}

function stubPictureClient(overrides: Partial<PictureClient> = {}): PictureClient {
  return {
    find: vi.fn(async () => null),
    upload: vi.fn(async () => ({ id: 'pic-new' }) as PictureMeta),
    remove: vi.fn(async () => undefined),
    url: (id: string) => `/api/pictures/${id}`,
    ...overrides,
  }
}

function renderWidget(
  ops: RelationOps,
  pictureClient: PictureClient,
  props: Partial<WidgetProps> = {},
) {
  const Widget = fieldWidget(photoField)
  render(
    <RelationOpsProvider ops={ops}>
      <PictureClientProvider client={pictureClient}>
        <Widget
          field={photoField}
          value={undefined}
          onChange={vi.fn()}
          entity="property_management"
          recordId={props.recordId !== undefined ? props.recordId : 'prop1'}
        />
      </PictureClientProvider>
    </RelationOpsProvider>,
  )
}

describe('relation/carousel', () => {
  it('shows the unsaved-record hint with no id yet', () => {
    renderWidget(stubOps(), stubPictureClient(), { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })

  it('shows "No photos yet." when the relation has no rows', async () => {
    renderWidget(stubOps(), stubPictureClient())
    expect(await screen.findByText('No photos yet.')).toBeInTheDocument()
    expect(screen.getByText('0 / 2')).toBeInTheDocument()
  })

  it('loads rows sorted by position and shows the first slide\'s picture', async () => {
    const rows: RelationRecord[] = [
      { id: 'p2', position: 1 },
      { id: 'p1', position: 0 },
    ]
    const ops = stubOps({ list: vi.fn(async () => rows) })
    const pictureClient = stubPictureClient({
      find: vi.fn(async (anchor) => (anchor.recordId === 'p1' ? ({ id: 'pic1' } as PictureMeta) : null)),
    })
    renderWidget(ops, pictureClient)

    await waitFor(() =>
      expect(ops.list).toHaveBeenCalledWith('property_management_photo', {
        filter: { property_management_id: 'prop1' },
        pageSize: 100,
      }),
    )
    // p1 (position 0) shows first despite arriving second in the list.
    expect(await screen.findByRole('img')).toHaveAttribute('src', '/api/pictures/pic1')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })

  it('navigates to the next/previous slide', async () => {
    const rows: RelationRecord[] = [
      { id: 'p1', position: 0 },
      { id: 'p2', position: 1 },
    ]
    const pictureClient = stubPictureClient({
      find: vi.fn(async (anchor) => ({ id: `pic-${anchor.recordId}` }) as PictureMeta),
    })
    renderWidget(stubOps({ list: vi.fn(async () => rows) }), pictureClient)

    expect(await screen.findByRole('img')).toHaveAttribute('src', '/api/pictures/pic-p1')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', '/api/pictures/pic-p2'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', '/api/pictures/pic-p1'))
  })

  it('adding a photo creates a row with the next position', async () => {
    const ops = stubOps()
    renderWidget(ops, stubPictureClient())
    await screen.findByText('No photos yet.')

    fireEvent.click(screen.getByRole('button', { name: 'Add photo' }))
    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('property_management_photo', {
        property_management_id: 'prop1',
        position: 0,
      }),
    )
  })

  it('disables Add photo once the max is reached', async () => {
    const rows: RelationRecord[] = [
      { id: 'p1', position: 0 },
      { id: 'p2', position: 1 },
    ]
    renderWidget(stubOps({ list: vi.fn(async () => rows) }), stubPictureClient())
    await screen.findByText('2 / 2')
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeDisabled()
  })

  it('deleting the current slide removes its picture then its row', async () => {
    const rows: RelationRecord[] = [{ id: 'p1', position: 0 }]
    const ops = stubOps({ list: vi.fn(async () => rows) })
    const pictureClient = stubPictureClient({ find: vi.fn(async () => ({ id: 'pic1' }) as PictureMeta) })
    renderWidget(ops, pictureClient)

    await screen.findByRole('img')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(pictureClient.remove).toHaveBeenCalledWith('pic1'))
    await waitFor(() => expect(ops.remove).toHaveBeenCalledWith('property_management_photo', 'p1'))
  })

  it('uploading into an empty slide sets its picture', async () => {
    const rows: RelationRecord[] = [{ id: 'p1', position: 0 }]
    const pictureClient = stubPictureClient()
    renderWidget(stubOps({ list: vi.fn(async () => rows) }), pictureClient)

    await screen.findByLabelText('Upload')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['img'], 'photo.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(pictureClient.upload).toHaveBeenCalledWith(
        { table: 'property_management_photo', recordId: 'p1', field: 'picture' },
        file,
        'photo.png',
      ),
    )
    expect(await screen.findByRole('img')).toHaveAttribute('src', '/api/pictures/pic-new')
  })
})
