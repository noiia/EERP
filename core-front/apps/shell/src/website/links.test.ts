import { describe, expect, it } from 'vitest'
import { kindOf, linkHref, SYSTEM_PAGES } from './links'

describe('linkHref', () => {
  it('login/signup carry the after-login page as ?next', () => {
    expect(linkHref('/login', 'book')).toBe('/login?next=%2Fbook')
    expect(linkHref('/signup', 'book')).toBe('/signup?next=%2Fbook')
  })
  it('no next, or an unsafe one, leaves the bare destination', () => {
    expect(linkHref('/login')).toBe('/login')
    expect(linkHref('/login', '')).toBe('/login')
    expect(linkHref('/login', '//evil')).toBe('/login')
    expect(linkHref('/signup', '/app')).toBe('/signup')
  })
  it('other destinations ignore next and stay safeHref-validated', () => {
    expect(linkHref('/account', 'book')).toBe('/account')
    expect(linkHref('/about', 'book')).toBe('/about')
    expect(linkHref('https://x.io')).toBe('https://x.io')
    expect(linkHref('javascript:x')).toBeUndefined()
    expect(linkHref(undefined)).toBeUndefined()
  })
})

describe('kindOf', () => {
  const pages = [{ slug: 'about' }]
  it('infers the picker kind from the stored href', () => {
    expect(kindOf('/login', pages)).toBe('login')
    expect(kindOf('/signup', pages)).toBe('signup')
    expect(kindOf('/account', pages)).toBe('account')
    expect(kindOf('/about', pages)).toBe('page')
    expect(kindOf('https://x.io', pages)).toBe('external')
    expect(kindOf('/unknown', pages)).toBe('external')
    expect(kindOf('', pages)).toBe('none')
  })
  it('exposes the system pages', () => {
    expect(SYSTEM_PAGES).toEqual({ login: '/login', signup: '/signup', account: '/account' })
  })
})
