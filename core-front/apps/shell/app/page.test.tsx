import { render, screen } from '@testing-library/react'
import HomePage from './page'

it('renders the placeholder home route', () => {
  render(<HomePage />)
  expect(screen.getByRole('heading', { name: 'EERP' })).toBeInTheDocument()
})
