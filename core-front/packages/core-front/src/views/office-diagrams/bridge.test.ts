import { afterEach, describe, expect, it } from 'vitest'
import { isDiagramSender } from './bridge'

afterEach(() => {
  document.body.innerHTML = ''
})
describe('Office diagram message boundary', () => {
  it('requires the plugin frame to belong to the current editor and origin', () => {
    const editor = document.createElement('iframe')
    const other = document.createElement('iframe')
    document.body.append(editor, other)
    const plugin = editor.contentDocument!.createElement('iframe')
    editor.contentDocument!.body.append(plugin)
    // jsdom does not navigate nested frames; supply the URL read by the guard.
    const sender = {
      frameElement: plugin,
      location: { pathname: '/euro-office/sdkjs-plugins/erp-diagrams/index.html' },
    }
    const event = { origin: window.location.origin, source: sender } as unknown as MessageEvent
    expect(isDiagramSender(event, editor)).toBe(true)
    expect(isDiagramSender(event, other)).toBe(false)
    expect(
      isDiagramSender({ ...event, origin: 'https://foreign.example' } as MessageEvent, editor),
    ).toBe(false)
    expect(isDiagramSender({ ...event, source: window } as MessageEvent, editor)).toBe(false)
    expect(isDiagramSender(event, null)).toBe(false)
    sender.location.pathname = '/app/another-page'
    expect(isDiagramSender(event, editor)).toBe(false)
  })
})
