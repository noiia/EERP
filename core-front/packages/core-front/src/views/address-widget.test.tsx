import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FieldDescriptor } from './descriptor'
import { fieldWidget, type WidgetProps } from './widgets'

// Composite field: reads sibling columns off `draft`, writes them via
// `onChangeField` — never its own `value`/`onChange` (there is no real
// "address" column). See descriptor.ts's FIELD_WIDGETS doc comment.

const addressField: FieldDescriptor = {
  name: 'address',
  label: 'Address',
  type: 'address',
}

function renderWidget(draft: Record<string, unknown>, extra?: Partial<WidgetProps>) {
  const onChangeField = vi.fn()
  const Widget = fieldWidget(addressField)
  const props: WidgetProps = {
    field: addressField,
    value: undefined,
    onChange: vi.fn(),
    onChangeField,
    draft,
    ...extra,
  }
  render(<Widget {...props} />)
  return { onChangeField }
}

describe('type: address', () => {
  it('shows the combined number+street, and each sub-field, seeded from sibling draft columns', () => {
    renderWidget({
      address_number: 12,
      address_street: 'Main Street',
      address_complement: 'Apt 3',
      address_zip_code: '75001',
      address_city: 'Paris',
      address_state: 'Île-de-France',
      address_country: 'France',
    })
    expect(screen.getByLabelText('Number and street')).toHaveValue('12 Main Street')
    expect(screen.getByLabelText('Complement')).toHaveValue('Apt 3')
    expect(screen.getByLabelText('Zip code')).toHaveValue('75001')
    expect(screen.getByLabelText('City')).toHaveValue('Paris')
    expect(screen.getByLabelText('State')).toHaveValue('Île-de-France')
    expect(screen.getByLabelText('Country')).toHaveValue('France')
  })

  it('renders blank sub-fields when no sibling columns are set yet (a brand-new record)', () => {
    renderWidget({})
    expect(screen.getByLabelText('Number and street')).toHaveValue('')
    expect(screen.getByLabelText('City')).toHaveValue('')
  })

  it('parses a combined "number street" edit into separate number/street writes on blur', () => {
    const { onChangeField } = renderWidget({})
    const input = screen.getByLabelText('Number and street')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '42 Baker Street' } })
    fireEvent.blur(input)
    expect(onChangeField).toHaveBeenCalledWith('address_number', 42)
    expect(onChangeField).toHaveBeenCalledWith('address_street', 'Baker Street')
  })

  it('leaves the number null when the typed line has no leading digits', () => {
    const { onChangeField } = renderWidget({})
    const input = screen.getByLabelText('Number and street')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Rue Sans Nom' } })
    fireEvent.blur(input)
    expect(onChangeField).toHaveBeenCalledWith('address_number', null)
    expect(onChangeField).toHaveBeenCalledWith('address_street', 'Rue Sans Nom')
  })

  it('clears both number and street when blurred empty', () => {
    const { onChangeField } = renderWidget({ address_number: 5, address_street: 'Old St' })
    const input = screen.getByLabelText('Number and street')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onChangeField).toHaveBeenCalledWith('address_number', null)
    expect(onChangeField).toHaveBeenCalledWith('address_street', '')
  })

  it('writes each other sub-field directly through onChangeField as typed', () => {
    const { onChangeField } = renderWidget({})
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Lyon' } })
    expect(onChangeField).toHaveBeenCalledWith('address_city', 'Lyon')
  })

  it('honors a custom field name as the sibling-column prefix', () => {
    const billingField: FieldDescriptor = { name: 'billing_address', label: 'Billing address', type: 'address' }
    const onChangeField = vi.fn()
    const Widget = fieldWidget(billingField)
    render(
      <Widget
        field={billingField}
        value={undefined}
        onChange={vi.fn()}
        onChangeField={onChangeField}
        draft={{ billing_address_city: 'Berlin' }}
      />,
    )
    expect(screen.getByLabelText('City')).toHaveValue('Berlin')
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Bavaria' } })
    expect(onChangeField).toHaveBeenCalledWith('billing_address_state', 'Bavaria')
  })
})

describe('type: address — OSM autocomplete', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('queries the BFF proxy (never Nominatim directly) once past the minimum query length, debounced', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderWidget({})

    const input = screen.getByLabelText('Number and street')
    fireEvent.change(input, { target: { value: '12 Ma' } })
    // Below OSM_MIN_QUERY_LENGTH's effective threshold isn't tested directly
    // here (5 chars already clears it) — the real guard is exercised by the
    // "does nothing below the minimum length" case below.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/integrations/osm/search?q=12%20Ma'))
  })

  it('does not query below the minimum query length', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderWidget({})

    fireEvent.change(screen.getByLabelText('Number and street'), { target: { value: '12' } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('selecting a suggestion fills all 7 sibling columns and stops the in-progress edit', async () => {
    const suggestion = {
      label: '12 Main Street, Springfield, USA',
      number: 12,
      street: 'Main Street',
      complement: '',
      zip_code: '00000',
      city: 'Springfield',
      state: 'Someplace',
      country: 'USA',
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [suggestion] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { onChangeField } = renderWidget({})

    const input = screen.getByLabelText('Number and street')
    fireEvent.change(input, { target: { value: '12 Main' } })
    const option = await screen.findByText(suggestion.label)
    fireEvent.click(option)

    expect(onChangeField).toHaveBeenCalledWith('address_number', 12)
    expect(onChangeField).toHaveBeenCalledWith('address_street', 'Main Street')
    expect(onChangeField).toHaveBeenCalledWith('address_zip_code', '00000')
    expect(onChangeField).toHaveBeenCalledWith('address_city', 'Springfield')
    expect(onChangeField).toHaveBeenCalledWith('address_state', 'Someplace')
    expect(onChangeField).toHaveBeenCalledWith('address_country', 'USA')
  })

  it('degrades to no suggestions (plain manual entry) when the proxy fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })))
    renderWidget({})
    fireEvent.change(screen.getByLabelText('Number and street'), { target: { value: '12 Main' } })
    // No crash, no suggestions — the field stays a plain, freely-typeable input.
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(screen.getByLabelText('Number and street')).toHaveValue('12 Main')
  })
})
