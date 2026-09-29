import { describe, expect, it } from 'vitest'
import { pageFormatFormDescriptor, pageFormatListDescriptor } from './descriptors'

// The page is a thin RSC shell; the wiring worth guarding lives in these
// descriptors — entity/route pairing, row-click form path, override fields.

describe('Settings → Global settings → Reports → page formats descriptors', () => {
  it('lists page formats over the report_page_format entity and opens a form on row click', () => {
    expect(pageFormatListDescriptor.entity).toBe('report_page_format')
    expect(pageFormatListDescriptor.viewType).toBe('tree')
    expect(pageFormatListDescriptor.formPath).toBe('/settings/appearance/page-formats/:id')
  })

  it('gates Create on the write permission', () => {
    expect(pageFormatListDescriptor.createPermission).toBe('report_page_format:report_page_format:write')
  })

  it('guards both views with the derived read permission', () => {
    expect(pageFormatListDescriptor.permissions).toContain('report_page_format:report_page_format:read')
    expect(pageFormatFormDescriptor.permissions).toContain('report_page_format:report_page_format:read')
  })

  it('requires name/width/height on the form, unit constrained to px/cm/in', () => {
    const required = pageFormatFormDescriptor.fields.filter((f) => f.required).map((f) => f.name)
    expect(required).toEqual(['name', 'width', 'height'])

    const unit = pageFormatFormDescriptor.fields.find((f) => f.name === 'unit')
    expect(unit?.selection?.options).toEqual(['px', 'cm', 'in'])
  })

  it('exposes every override field as optional (unset = inherit)', () => {
    const names = pageFormatFormDescriptor.fields.map((f) => f.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'padding',
        'color_text',
        'color_text_muted',
        'color_border',
        'color_accent',
        'footer',
        'address',
      ]),
    )
    const overrides = pageFormatFormDescriptor.fields.filter((f) =>
      ['padding', 'color_text', 'color_text_muted', 'color_border', 'color_accent', 'footer', 'address'].includes(
        f.name,
      ),
    )
    expect(overrides.every((f) => !f.required)).toBe(true)
  })

  it('keeps the list compact (no override columns), the form carries every field', () => {
    expect(pageFormatListDescriptor.fields.map((f) => f.name)).toEqual(['name', 'width', 'height', 'unit'])
  })

  it('renders every color override as a color-swatch widget', () => {
    const colorFields = pageFormatFormDescriptor.fields.filter((f) => f.name.startsWith('color_'))
    expect(colorFields).toHaveLength(4)
    expect(colorFields.every((f) => f.widget === 'color')).toBe(true)
  })

  it('offers a Standard size preset selector that patches width/height/unit, with no column of its own', () => {
    const preset = pageFormatFormDescriptor.fields.find((f) => f.name === 'size_preset')
    expect(preset?.widget).toBe('linked')
    expect(preset?.store).toBe(false)
    expect(preset?.selection?.options[0]).toBe('Custom') // first = the field's default, a deliberate no-op
    expect(preset?.widgetOptions?.presets).toMatchObject({
      A4: { width: 21, height: 29.7, unit: 'cm' },
      Letter: { width: 8.5, height: 11, unit: 'in' },
    })
  })

  it('places the preset selector before the manual width/height/unit fields', () => {
    const names = pageFormatFormDescriptor.fields.map((f) => f.name)
    expect(names.indexOf('size_preset')).toBeLessThan(names.indexOf('width'))
  })
})
