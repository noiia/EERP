import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_NUMBER_FORMAT, useFormatStore } from '@eerp/core-front'
import type { NumberFormatPreference } from '@/lib/locale'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/preferences', () => ({
  setWorkspaceNumberFormat: (format: NumberFormatPreference) => saveMock(format),
}))

import FormatSettings from './FormatSettings'

async function pickOption(selectLabel: string, optionName: string) {
  fireEvent.mouseDown(screen.getByLabelText(selectLabel))
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}

describe('FormatSettings', () => {
  beforeEach(() => {
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true })
    useFormatStore.setState({ ...DEFAULT_NUMBER_FORMAT })
  })

  it('previews the active format', () => {
    render(<FormatSettings canEdit />)
    expect(screen.getByTestId('format-preview')).toHaveTextContent('1,234,567.89')
  })

  it('saves a change optimistically and reformats the preview', async () => {
    render(<FormatSettings canEdit />)
    await pickOption('Thousands separator', 'Space')

    expect(useFormatStore.getState().thousandsSeparator).toBe(' ')
    expect(screen.getByTestId('format-preview')).toHaveTextContent('1 234 567.89')
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ decimal_separator: '.', thousands_separator: ' ' }),
    )
  })

  it('refuses identical separators without calling the server', async () => {
    render(<FormatSettings canEdit />)
    // Default thousands is ',' — picking ',' as decimal would collide.
    await pickOption('Decimal separator', 'Comma')

    expect(await screen.findByText(/must differ/i)).toBeInTheDocument()
    expect(saveMock).not.toHaveBeenCalled()
    expect(useFormatStore.getState().decimalSeparator).toBe('.')
  })

  it('reverts the mirror and surfaces the message when the save fails', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Forbidden: settings:format:write' })
    render(<FormatSettings canEdit />)
    await pickOption('Thousands separator', 'Space')

    expect(await screen.findByText('Forbidden: settings:format:write')).toBeInTheDocument()
    expect(useFormatStore.getState().thousandsSeparator).toBe(',')
  })

  it('renders read-only without the write permission', () => {
    render(<FormatSettings canEdit={false} />)
    expect(screen.getByLabelText('Decimal separator')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/settings:format:write permission/)).toBeInTheDocument()
  })
})
