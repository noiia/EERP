import { render, screen } from '@testing-library/react'
import { App } from './App'

it('renders the placeholder home route', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'EERP' })).toBeInTheDocument()
})
