import {
  erpPath,
  registerHeaderButtonAction,
  type FrontModule,
  type HeaderButtonDescriptor,
  type ViewDescriptor,
} from '@eerp/core-front'

// website frontend — DESCRIPTORS ONLY. `entity` maps 1:1 to the Go route prefix
// (GET /api/v1/website_page); permissions mirror the route:
// website_page:website_page:<action>. `layout` (JSONB) is deliberately absent:
// only the Design editor writes it.

/** A website page as served by Go's /website_page endpoints. */
export interface WebsitePage {
  id: string
  slug: string
  title: string
  seo_description?: string | null
  published?: boolean | null
  in_menu?: boolean | null
  menu_sequence?: number | null
  /** true ⇔ a background picture exists on the (website_page, id, background) anchor. */
  background?: boolean | null
  background_parallax?: boolean | null
}

const listFields: ViewDescriptor['fields'] = [
  { name: 'title', label: 'Title', type: 'text', required: true },
  { name: 'slug', label: 'Slug (empty = home page; lowercase letters, digits, dashes)', type: 'text' },
  { name: 'published', label: 'Published', type: 'boolean', widget: 'switch' },
  { name: 'in_menu', label: 'In menu', type: 'boolean', widget: 'switch' },
]

const formFields: ViewDescriptor['fields'] = [
  ...listFields,
  { name: 'menu_sequence', label: 'Menu order', type: 'number', widget: 'int' },
  { name: 'seo_description', label: 'SEO description', type: 'text', widget: 'long' },
  // The site draws it behind the page's blocks; parallax keeps it fixed while scrolling.
  { name: 'background', label: 'Background picture', type: 'boolean', widget: 'picture' },
  { name: 'background_parallax', label: 'Parallax background', type: 'boolean', widget: 'switch' },
]

registerHeaderButtonAction({
  entity: 'website_page',
  name: 'website.design',
  handler: (ctx) => {
    window.location.assign(erpPath(`/website/pages/${ctx.recordId}/design`))
  },
})

const headerButtons: HeaderButtonDescriptor[] = [
  {
    name: 'website.design',
    label: 'Design',
    states: { visible: { field: 'id', op: 'set' } },
  },
]

const permissions = ['website_page:website_page:read']

const dashboardView: ViewDescriptor = { entity: 'website_page', viewType: 'dashboard', fields: listFields, permissions }

const listView: ViewDescriptor = {
  entity: 'website_page',
  viewType: 'tree',
  fields: listFields,
  formPath: '/website/pages/:id',
  createPermission: 'website_page:website_page:write',
  permissions,
}

const formView: ViewDescriptor = {
  entity: 'website_page',
  viewType: 'form',
  fields: formFields,
  headerButtons,
  permissions,
}

const website: FrontModule = {
  name: 'website',
  routes: [
    { path: '/website', descriptor: dashboardView },
    { path: '/website/pages', descriptor: listView },
    { path: '/website/pages/:id', descriptor: formView },
  ],
}

export default website
