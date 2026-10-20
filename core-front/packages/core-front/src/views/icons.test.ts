import { describe, expect, it } from 'vitest'
import { faGlobe } from '@fortawesome/free-solid-svg-icons'
import { byPrefixAndName, registerIcons } from './icons'
import { solidIcon } from './solid-icon'

describe('byPrefixAndName', () => {
  it('holds the built-in icons by name, and only those', () => {
    expect(byPrefixAndName.fas['xmark']?.iconName).toBe('xmark')
    expect(byPrefixAndName.fas['eye-slash']?.iconName).toBe('eye-slash')
    // Not every Solid icon: the full set is what this list keeps out of the bundle.
    expect(byPrefixAndName.fas['globe']).toBeUndefined()
  })

  it('registerIcons adds an icon to the lookup', () => {
    registerIcons(faGlobe)
    expect(byPrefixAndName.fas['globe']).toBe(faGlobe)
  })
})

describe('solidIcon', () => {
  it('finds any Solid icon by name', () => {
    expect(solidIcon('handshake')?.iconName).toBe('handshake')
  })

  it('answers undefined for an unknown or missing name', () => {
    expect(solidIcon('not-a-real-icon')).toBeUndefined()
    expect(solidIcon(undefined)).toBeUndefined()
  })
})
