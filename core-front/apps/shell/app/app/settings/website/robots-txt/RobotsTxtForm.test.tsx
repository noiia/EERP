import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const saveRobotsExtra = vi.fn()
const previewSiteFile = vi.fn()
vi.mock('@/lib/website-settings', () => ({
  saveRobotsExtra: (...a: unknown[]) => saveRobotsExtra(...a),
  previewSiteFile: (...a: unknown[]) => previewSiteFile(...a),
}))

import RobotsTxtForm from './RobotsTxtForm'

beforeEach(() => {
  saveRobotsExtra.mockReset()
  previewSiteFile.mockReset()
})

it('saves the extra lines and refreshes the served-file preview', async () => {
  previewSiteFile.mockResolvedValueOnce('User-agent: *').mockResolvedValueOnce('User-agent: *\nDisallow: /drafts')
  saveRobotsExtra.mockResolvedValue({ ok: true })
  render(<RobotsTxtForm initial="" />)
  expect(await screen.findByText('User-agent: *')).toBeTruthy()

  fireEvent.change(screen.getByLabelText('Additional rules'), { target: { value: 'Disallow: /drafts' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(await screen.findByText('Saved.')).toBeTruthy()
  expect(saveRobotsExtra).toHaveBeenCalledWith('Disallow: /drafts')
  expect(await screen.findByText(/Disallow: \/drafts/, { selector: 'pre' })).toBeTruthy()
})

it("shows Go's message on a rejected save, else the translated fallback", async () => {
  previewSiteFile.mockResolvedValue('')
  saveRobotsExtra.mockResolvedValueOnce({ ok: false, message: 'bad line' })
  saveRobotsExtra.mockResolvedValueOnce({ ok: false, message: '' })
  render(<RobotsTxtForm initial="x" />)

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('bad line')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Could not save.')).toBeTruthy()
})
