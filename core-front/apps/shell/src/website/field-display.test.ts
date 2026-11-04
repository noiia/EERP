import { describe, expect, it } from 'vitest'
import { accessibleLabel, resolveDisplay, visibleLabel, withFieldDisplay } from './field-display'

describe('labels', () => {
  const label = (hide_label: boolean, custom_label: string) => {
    const d = resolveDisplay({ phone: { hide_label, custom_label } }, 'phone')
    return { visible: visibleLabel(d, 'Phone'), spoken: accessibleLabel(d, 'Phone') }
  }

  it.each([
    [false, '', 'Phone', 'Phone'],
    [false, 'Contact us', 'Contact us', 'Contact us'],
    [true, '', null, 'Phone'],
    [true, 'Contact us', null, 'Contact us'], // hiding wins; the custom one is still read out
  ])('hide_label=%s custom_label=%j → shows %j, reads %j', (hide, custom, visible, spoken) => {
    expect(label(hide, custom)).toEqual({ visible, spoken })
  })

  it('treats a blank custom label as none', () => {
    expect(visibleLabel(resolveDisplay({ f: { custom_label: '   ' } }, 'f'), 'Field')).toBe('Field')
  })
})

describe('resolveDisplay (missing and malformed settings)', () => {
  it('gives the defaults to a block saved before field settings existed', () => {
    for (const displays of [undefined, null, {}, 'junk', { other: { hide_label: true } }]) {
      expect(resolveDisplay(displays, 'phone')).toEqual({ hideLabel: false, customLabel: '', format: {}, icon: null })
    }
  })

  it('fills an icon’s missing or unknown settings with defaults', () => {
    expect(resolveDisplay({ f: { icon: { name: 'phone' } } }, 'f').icon)
      .toEqual({ name: 'phone', family: 'solid', position: 'before', spacing: 'normal', color: 'inherit' })
    expect(resolveDisplay({ f: { icon: { name: 'x', family: 'pro', position: 'above', spacing: 9, color: '#f00' } } }, 'f').icon)
      .toEqual({ name: 'x', family: 'solid', position: 'before', spacing: 'normal', color: 'inherit' })
    expect(resolveDisplay({ f: { icon: { name: '' } } }, 'f').icon).toBeNull()
  })
})

describe('withFieldDisplay (what is saved)', () => {
  it('saves only what differs from the defaults and round-trips through JSON', () => {
    const saved = withFieldDisplay({}, 'phone', {
      hide_label: false, custom_label: ' Call us ', format: { as: 'auto', country: 'US', currency: '' },
      icon: { name: 'phone', family: 'solid', position: 'after', spacing: 'loose', color: 'muted' },
    })
    expect(saved).toEqual({ phone: { custom_label: 'Call us', format: { country: 'US' }, icon: { name: 'phone', family: 'solid', position: 'after', spacing: 'loose', color: 'muted' } } })
    const restored = resolveDisplay(JSON.parse(JSON.stringify(saved)), 'phone')
    expect(restored.customLabel).toBe('Call us')
    expect(restored.format).toEqual({ country: 'US' })
    expect(restored.icon?.position).toBe('after')
  })

  it('drops a field back to defaults, keeping the other fields', () => {
    const all = { a: { hide_label: true }, b: { custom_label: 'B' } }
    expect(withFieldDisplay(all, 'a', null)).toEqual({ b: { custom_label: 'B' } })
    expect(withFieldDisplay(all, 'b', { hide_label: false, format: { as: 'auto' } })).toEqual({ a: { hide_label: true } })
    expect(all).toEqual({ a: { hide_label: true }, b: { custom_label: 'B' } }) // not mutated
  })
})
