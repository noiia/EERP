import { afterEach, describe, expect, it } from 'vitest'
import { headerMenuRegistry, registerHeaderMenu } from './header-menu-registry'

afterEach(() => {
  headerMenuRegistry.clear()
})

describe('registerHeaderMenu', () => {
  it('creates a new menu retrievable by module', () => {
    registerHeaderMenu('sale', 'configuration', {
      label: 'Configuration',
      entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
    })
    const menus = headerMenuRegistry.forModule('sale')
    expect(menus).toEqual([
      {
        name: 'configuration',
        label: 'Configuration',
        entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
      },
    ])
  })

  it('appends a second call under the same (module, name) rather than replacing it', () => {
    registerHeaderMenu('sale', 'configuration', {
      entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
    })
    registerHeaderMenu('sale', 'configuration', {
      entries: [{ kind: 'line', label: 'Currencies', path: '/sale/currencies' }],
    })
    const menu = headerMenuRegistry.forModule('sale')[0]
    expect(menu.entries).toEqual([
      { kind: 'line', label: 'Taxes', path: '/sale/taxes' },
      { kind: 'line', label: 'Currencies', path: '/sale/currencies' },
    ])
  })

  it('keeps the label from the first call when a later call omits it', () => {
    registerHeaderMenu('sale', 'configuration', {
      label: 'Configuration',
      entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
    })
    registerHeaderMenu('sale', 'configuration', {
      entries: [{ kind: 'line', label: 'Currencies', path: '/sale/currencies' }],
    })
    expect(headerMenuRegistry.forModule('sale')[0].label).toBe('Configuration')
  })

  it('merges a group node into an existing same-labeled group instead of duplicating it', () => {
    registerHeaderMenu('sale', 'configuration', {
      entries: [
        {
          kind: 'group',
          label: 'Finance',
          children: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
        },
      ],
    })
    registerHeaderMenu('sale', 'configuration', {
      entries: [
        {
          kind: 'group',
          label: 'Finance',
          children: [{ kind: 'line', label: 'Currencies', path: '/sale/currencies' }],
        },
      ],
    })
    const menu = headerMenuRegistry.forModule('sale')[0]
    expect(menu.entries).toEqual([
      {
        kind: 'group',
        label: 'Finance',
        children: [
          { kind: 'line', label: 'Taxes', path: '/sale/taxes' },
          { kind: 'line', label: 'Currencies', path: '/sale/currencies' },
        ],
      },
    ])
  })

  it('keeps menus scoped per module', () => {
    registerHeaderMenu('sale', 'configuration', {
      entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
    })
    registerHeaderMenu('propertymanagement', 'configuration', {
      entries: [
        { kind: 'line', label: 'Equipment types', path: '/propertymanagement/equipment-types' },
      ],
    })
    expect(headerMenuRegistry.forModule('sale')).toHaveLength(1)
    expect(headerMenuRegistry.forModule('propertymanagement')).toHaveLength(1)
    expect(headerMenuRegistry.forModule('propertymanagement')[0].entries).toEqual([
      { kind: 'line', label: 'Equipment types', path: '/propertymanagement/equipment-types' },
    ])
  })

  it('rejects a line with no path', () => {
    expect(() =>
      registerHeaderMenu('sale', 'configuration', {
        entries: [{ kind: 'line', label: 'Taxes', path: '' }],
      }),
    ).toThrowError(/non-empty path/)
  })

  it('rejects a group with no children', () => {
    expect(() =>
      registerHeaderMenu('sale', 'configuration', {
        entries: [{ kind: 'group', label: 'Finance', children: [] }],
      }),
    ).toThrowError(/at least one line/)
  })

  it('rejects two sibling lines sharing a label', () => {
    registerHeaderMenu('sale', 'configuration', {
      entries: [{ kind: 'line', label: 'Taxes', path: '/sale/taxes' }],
    })
    expect(() =>
      registerHeaderMenu('sale', 'configuration', {
        entries: [{ kind: 'line', label: 'Taxes', path: '/sale/other-taxes' }],
      }),
    ).toThrowError(/duplicate header menu line label/)
  })

  it('names the failing module/menu in the error', () => {
    expect(() =>
      registerHeaderMenu('sale', 'configuration', {
        entries: [{ kind: 'group', label: 'Finance', children: [] }],
      }),
    ).toThrowError(/header menu "sale:configuration"/)
  })
})
