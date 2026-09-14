import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { I18nInit } from './I18nInit'

// The real generated manifest is a build artefact (aliased to an empty stub in
// vitest.config.ts); what matters here is that mounting I18nInit pulls it in (the
// import side effect registers the catalogs) and contributes no UI of its own.

describe('I18nInit', () => {
  it('renders nothing — it only imports the generated catalogs', () => {
    const { container } = render(<I18nInit />)
    expect(container).toBeEmptyDOMElement()
  })
})
