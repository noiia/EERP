import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CatalogRenderer } from './catalog-renderer'
import type { ViewDescriptor } from './descriptor'
import { useRecentlyChangedStore } from './recently-changed-store'

// Catalog rows navigate to a record's form via the App Router, exactly like
// TreeRenderer's flat rows (renderers.test.tsx).
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

interface ModuleRecord {
  id: string
  icon?: string
  display_name: string
  description?: string
}

const descriptor: ViewDescriptor<ModuleRecord> = {
  entity: 'modules',
  viewType: 'catalog',
  fields: [
    { name: 'icon', label: 'Icon', type: 'text' },
    { name: 'display_name', label: 'Display name', type: 'text' },
    { name: 'description', label: 'Description', type: 'text' },
  ],
  catalog: { icon: 'icon', title: 'display_name', subtitle: 'description' },
  formPath: '/appstore/:id',
}

beforeEach(() => {
  pushMock.mockClear()
  useRecentlyChangedStore.setState({ ids: new Set() })
})

describe('CatalogRenderer', () => {
  it('renders one row per record with its title and subtitle values', () => {
    render(
      <CatalogRenderer
        descriptor={descriptor}
        initialData={[
          { id: 'crm', icon: '📇', display_name: 'CRM', description: 'CRM core module' },
          { id: 'contact', icon: '👤', display_name: 'Contact', description: 'Contact core module' },
        ]}
      />,
    )
    expect(screen.getByText('CRM')).toBeInTheDocument()
    expect(screen.getByText('CRM core module')).toBeInTheDocument()
    expect(screen.getByText('Contact')).toBeInTheDocument()
    expect(screen.getByText('Contact core module')).toBeInTheDocument()
    // The icon value renders as-is (an emoji, in this fixture).
    expect(screen.getByText('📇')).toBeInTheDocument()
  })

  it('falls back to a letter avatar when the record has no icon value', () => {
    render(
      <CatalogRenderer
        descriptor={descriptor}
        initialData={[{ id: 'crm', display_name: 'CRM', description: 'CRM core module' }]}
      />,
    )
    // No icon in the data — the avatar shows the title's first letter, uppercased.
    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('clicking a row navigates to formPath with :id replaced by the record id', () => {
    render(
      <CatalogRenderer
        descriptor={descriptor}
        initialData={[{ id: 'crm', display_name: 'CRM', description: 'CRM core module' }]}
      />,
    )
    screen.getByText('CRM').click()
    expect(pushMock).toHaveBeenCalledWith('/appstore/crm')
  })

  it('does not navigate when the descriptor declares no formPath', () => {
    render(
      <CatalogRenderer
        descriptor={{ ...descriptor, formPath: undefined }}
        initialData={[{ id: 'crm', display_name: 'CRM' }]}
      />,
    )
    screen.getByText('CRM').click()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('renders no subtitle line when the record has none', () => {
    render(
      <CatalogRenderer descriptor={descriptor} initialData={[{ id: 'crm', display_name: 'CRM' }]} />,
    )
    expect(screen.getByText('CRM')).toBeInTheDocument()
    expect(screen.queryByText('undefined')).not.toBeInTheDocument()
  })

  it('shows an empty state with zero records', () => {
    render(<CatalogRenderer descriptor={descriptor} initialData={[]} />)
    expect(screen.getByText('No entries.')).toBeInTheDocument()
  })

  it('badges a row whose id was marked recently changed', () => {
    useRecentlyChangedStore.setState({ ids: new Set(['crm']) })
    render(
      <CatalogRenderer
        descriptor={descriptor}
        initialData={[
          { id: 'crm', display_name: 'CRM', description: 'CRM core module' },
          { id: 'contact', display_name: 'Contact', description: 'Contact core module' },
        ]}
      />,
    )
    expect(screen.getByText('Updated')).toBeInTheDocument()
  })

  it('badges no row when nothing was recently changed', () => {
    render(
      <CatalogRenderer
        descriptor={descriptor}
        initialData={[{ id: 'crm', display_name: 'CRM', description: 'CRM core module' }]}
      />,
    )
    expect(screen.queryByText('Updated')).not.toBeInTheDocument()
  })
})
