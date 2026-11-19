import type { MetadataRoute } from 'next'

// PWA manifest (/manifest.webmanifest, linked by Next automatically). Its icon is
// the workspace favicon, which Go falls back to the default company's logo.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'EERP',
    short_name: 'EERP',
    start_url: '/app',
    display: 'standalone',
    icons: [{ src: '/api/v1/public/favicon', sizes: 'any' }],
  }
}
