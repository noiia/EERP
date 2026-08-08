import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PictureSize } from '@/lib/app-settings'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/app-settings', () => ({
  setModulePictureSize: (module: string, size: PictureSize | null) => saveMock(module, size),
}))

import PictureSizeSettings from './PictureSizeSettings'

describe('PictureSizeSettings — module === "base"', () => {
  beforeEach(() => {
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true })
  })

  it('shows no override checkbox — Base has nothing to inherit from', () => {
    render(<PictureSizeSettings module="base" canEdit initialOverride={null} base={null} />)
    expect(screen.queryByLabelText('Override for this app')).not.toBeInTheDocument()
  })

  it('shows the stored value, or the hardcoded default when unset', () => {
    render(<PictureSizeSettings module="base" canEdit initialOverride={null} base={null} />)
    expect(screen.getByLabelText('Width')).toHaveValue(160)
    expect(screen.getByLabelText('Height')).toHaveValue(96)
  })

  it('saves the base value directly on blur', async () => {
    render(<PictureSizeSettings module="base" canEdit initialOverride={{ width: 160, height: 96 }} base={null} />)
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '200' } })
    fireEvent.blur(screen.getByLabelText('Width'))

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('base', { width: 200, height: 96 }))
  })

  it('surfaces the error message on a failed save', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Missing permission settings:apps:write' })
    render(<PictureSizeSettings module="base" canEdit initialOverride={null} base={null} />)
    fireEvent.blur(screen.getByLabelText('Width'))

    expect(await screen.findByText('Missing permission settings:apps:write')).toBeInTheDocument()
  })

  it('renders read-only without the write permission', () => {
    render(<PictureSizeSettings module="base" canEdit={false} initialOverride={null} base={null} />)
    expect(screen.getByLabelText('Width')).toBeDisabled()
    expect(screen.getByText(/settings:apps:write permission/)).toBeInTheDocument()
  })
})

describe('PictureSizeSettings — a real module', () => {
  beforeEach(() => {
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true })
  })

  it('starts unchecked and shows the inherited Base value when no override is stored', () => {
    render(<PictureSizeSettings module="crm" canEdit initialOverride={null} base={{ width: 200, height: 150 }} />)
    expect(screen.getByLabelText('Override for this app')).not.toBeChecked()
    expect(screen.getByText(/Inherits Base:/)).toHaveTextContent('Inherits Base: 200×150')
    expect(screen.getByLabelText('Width')).toBeDisabled()
  })

  it('falls back to the hardcoded default in the inherited hint when Base is also unset', () => {
    render(<PictureSizeSettings module="crm" canEdit initialOverride={null} base={null} />)
    expect(screen.getByText(/Inherits Base:/)).toHaveTextContent('Inherits Base: 160×96')
  })

  it('starts checked with the stored override when one exists', () => {
    render(
      <PictureSizeSettings module="crm" canEdit initialOverride={{ width: 300, height: 300 }} base={null} />,
    )
    expect(screen.getByLabelText('Override for this app')).toBeChecked()
    expect(screen.getByLabelText('Width')).toHaveValue(300)
    expect(screen.getByLabelText('Width')).toBeEnabled()
  })

  it('checking the override saves the current (inherited) value as the new override', async () => {
    render(<PictureSizeSettings module="crm" canEdit initialOverride={null} base={{ width: 200, height: 150 }} />)
    fireEvent.click(screen.getByLabelText('Override for this app'))

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith('crm', { width: 200, height: 150 }),
    )
    expect(screen.getByLabelText('Width')).toBeEnabled()
  })

  it('unchecking the override clears it back to inheriting Base', async () => {
    render(
      <PictureSizeSettings module="crm" canEdit initialOverride={{ width: 300, height: 300 }} base={null} />,
    )
    fireEvent.click(screen.getByLabelText('Override for this app'))

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('crm', null))
    expect(screen.getByLabelText('Width')).toBeDisabled()
  })

  it('editing a dimension while overridden saves on blur', async () => {
    render(
      <PictureSizeSettings module="crm" canEdit initialOverride={{ width: 300, height: 300 }} base={null} />,
    )
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '400' } })
    fireEvent.blur(screen.getByLabelText('Height'))

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('crm', { width: 300, height: 400 }))
  })
})
