// The light seed's demo website (dev-seed.ts seedWebsite): a copy of the site built
// on the dev workspace — a home page (welcome text, upcoming events carousel,
// product grid), an events list, a product catalog and the two detail pages their
// cards link to (an event with its booking block, a product with its variants).
// Kept apart from dev-seed.ts because a 'use server' file may only export async
// functions. The blocks only point at tables and slugs, never at record ids, so
// they show whatever events and products the seed (or the user) created.

/** What the site reads anonymously: Settings → Website → Publishing, per table. */
export const DEMO_SITE_PUBLISHED: { table: string; fields: string[]; filter: Record<string, string> }[] = [
  {
    table: 'website_page',
    fields: ['slug', 'title', 'seo_description', 'in_menu', 'menu_sequence', 'layout', 'background', 'background_parallax'],
    filter: { published: 'true' },
  },
  {
    table: 'event',
    fields: ['name', 'description', 'location', 'kind', 'slot_minutes', 'timezone', 'picture', 'max_seats_per_booking'],
    filter: { published: 'true' },
  },
  { table: 'product', fields: ['description', 'unit_price', 'reference', 'name', 'picture', 'uom_id'], filter: {} },
  { table: 'product_variant', fields: ['unit_price', 'name', 'picture', 'product_id'], filter: {} },
]

const listBlock = { field: '', filter: {}, record: '', records: [] }

/** The pages, in menu order; `slug` is unique per workspace, so an existing one is skipped. */
export const DEMO_SITE_PAGES: Record<string, unknown>[] = [
  {
    slug: 'home', title: 'home', published: true, in_menu: true, menu_sequence: 0, background: false, background_parallax: true,
    layout: [
      {
        id: 'b-f42674d0', type: 'text', x: 0, y: 0, w: 36, h: 6,
        config: { heading: 'Bienvenue sur notre site de réservation', body: 'Pensez à prendre vos places 48h avant chaque événements.', align: 'center' },
      },
      {
        id: 'b-3aaf19fe', type: 'record_carousel', x: 0, y: 6, w: 36, h: 18,
        config: {
          ...listBlock, table: 'event', limit: 10, title_field: 'name', picture_field: 'picture', picture_position: 'top',
          fields: ['description', 'location', 'kind', 'timezone'], detail_slug: 'event-details',
        },
      },
      {
        id: 'b-82566a65', type: 'record_list', x: 0, y: 24, w: 36, h: 26,
        config: {
          ...listBlock, table: 'product', display: 'grid', page_size: 12, title_field: 'name', picture_field: 'picture',
          fields: ['description', 'reference', 'unit_price'], detail_slug: 'product',
        },
      },
    ],
  },
  {
    slug: 'events', title: 'events', published: true, in_menu: true, menu_sequence: 0, background: false, background_parallax: false,
    layout: [
      { id: 'b-b87204f4', type: 'event_list', x: 0, y: 0, w: 36, h: 56, config: { display: 'cards', limit: 12, nearest: true, detail_slug: 'event-details' } },
    ],
  },
  {
    slug: 'products', title: 'products', published: true, in_menu: true, menu_sequence: 0, background: false, background_parallax: false,
    layout: [
      {
        id: 'b-72c61977', type: 'record_list', x: 0, y: 0, w: 36, h: 60,
        config: {
          ...listBlock, table: 'product', display: 'grid', page_size: 30, title_field: 'name', picture_field: 'picture',
          fields: ['description', 'reference', 'unit_price', 'uom_id'], detail_slug: 'product',
        },
      },
    ],
  },
  {
    slug: 'event-details', title: 'event-details', published: true, in_menu: false, menu_sequence: 0, background: false, background_parallax: false,
    layout: [
      {
        id: 'b-88d128ab', type: 'record_detail', x: 0, y: 0, w: 36, h: 18,
        config: {
          ...listBlock, table: 'event', title_field: 'name', picture_field: 'picture',
          fields: ['description', 'location', 'kind', 'slot_minutes', 'max_seats_per_booking'],
        },
      },
      { id: 'b-27e160b5', type: 'event_booking', x: 0, y: 18, w: 21, h: 33, config: { login_required: false } },
    ],
  },
  {
    slug: 'product', title: 'product-details', published: true, in_menu: false, menu_sequence: 0, background: false, background_parallax: false,
    layout: [
      {
        id: 'b-dffeba5f', type: 'record_detail', x: 0, y: 0, w: 36, h: 36,
        config: {
          ...listBlock, table: 'product', title_field: 'name', picture_field: 'picture',
          fields: ['description', 'unit_price', 'reference'],
          related: { table: 'product_variant', link_field: 'product_id', title_field: 'name', picture_field: 'picture', fields: ['unit_price'] },
        },
      },
    ],
  },
]
